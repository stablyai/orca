#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const STARTUP_TIMEOUT_MS = 20_000
const commandArgs = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
if (!appImageArg) {
  fail('Usage: run-headless-linux-pairing-docker.mjs --appimage /path/to/orca.AppImage')
}
const appImage = resolve(appImageArg)
if (!existsSync(appImage)) {
  fail(`AppImage not found: ${appImage}`)
}

const suffix = `${process.pid}-${Date.now()}`
const artifactVolume = `orca-headless-pairing-artifact-${suffix}`
const network = `orca-headless-pairing-${suffix}`
const containers = new Set()
const images = [
  {
    name: 'ubuntu-24.04',
    tag: 'orca-headless-pairing:ubuntu-24.04',
    base: 'ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90',
    libasound: 'libasound2t64'
  },
  {
    name: 'debian-13',
    tag: 'orca-headless-pairing:debian-13',
    base: 'debian@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd',
    libasound: 'libasound2t64'
  }
]

try {
  docker(['volume', 'create', artifactVolume])
  docker(['network', 'create', network])
  for (const image of images) {
    buildImage(image)
  }
  extractAppImage(images[0].tag)
  await validateAuthenticatedPairing()
  console.log('Headless Linux pairing Docker validation passed.')
} finally {
  for (const container of containers) {
    docker(['rm', '-f', container], { allowFailure: true })
  }
  docker(['network', 'rm', network], { allowFailure: true })
  docker(['volume', 'rm', artifactVolume], { allowFailure: true })
}

function valueAfter(flag) {
  const index = commandArgs.indexOf(flag)
  return index === -1 ? null : (commandArgs[index + 1] ?? null)
}

function buildImage(image) {
  console.log(`Building ${image.name} fixture...`)
  const buildArgs = [
    'build',
    '--build-arg',
    `BASE_IMAGE=${image.base}`,
    '--build-arg',
    `LIBASOUND_PACKAGE=${image.libasound}`,
    '-f',
    'config/docker/headless-pairing/Dockerfile',
    '-t',
    image.tag,
    '.'
  ]
  // Why: apt fetches from archive.ubuntu.com stall or fail mid-sync; a second build usually lands on a healthy index.
  try {
    docker(buildArgs)
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\nRetrying docker build once...`
    )
    docker(buildArgs)
  }
}

function extractAppImage(image) {
  console.log('Extracting AppImage once without FUSE...')
  // Why: AppImage extraction creates a root-only directory, while launch cases intentionally run as the service user.
  docker([
    'run',
    '--rm',
    '--entrypoint',
    'bash',
    '-v',
    `${appImage}:/input/orca.AppImage:ro`,
    '-v',
    `${artifactVolume}:/artifacts`,
    image,
    '-lc',
    'cp /input/orca.AppImage /artifacts/orca.AppImage && chmod +x /artifacts/orca.AppImage && cd /artifacts && ./orca.AppImage --appimage-extract >/dev/null && chmod -R a+rX /artifacts/squashfs-root'
  ])
}

async function validateAuthenticatedPairing() {
  const server = await startAndWait({
    image: images[0],
    launch: 'direct',
    mode: 'json',
    address: 'ws://orca-pairing-server:6768/runtime?route=runtime',
    port: '6768',
    networkAlias: 'orca-pairing-server'
  })
  const payload = readyJson(server.stdout)
  const client = runPairingClient(payload.pairing.url)
  assert(client.status === 0, `pairing client failed:\n${client.stderr}\n${client.stdout}`)
  const status = lastJsonObject(client.stdout)
  const statusResult = status?.result ?? status
  assert(
    statusResult?.runtime?.state === 'ready',
    `paired client did not report runtime.state=ready: ${JSON.stringify(status)}`
  )
  assert(
    statusResult?.reachable === true || statusResult?.runtime?.reachable === true,
    `paired client did not report reachable=true: ${JSON.stringify(status)}`
  )
  assert(
    statusResult?.runtime?.runtimeId === payload.runtimeId ||
      status?._meta?.runtimeId === payload.runtimeId,
    'paired client runtime ID does not match ready contract'
  )
  assert(
    typeof statusResult?.runtime?.appVersion === 'string',
    'paired server did not report its Orca app version'
  )
  assert(
    statusResult?.runtime?.capabilities?.includes('updater.remote-control.v1'),
    'paired server did not advertise remote updater capability'
  )
  assert(
    statusResult?.runtime?.remoteUpdateSupport?.automatic === false &&
      statusResult.runtime.remoteUpdateSupport.reason === 'manual-service-update-required',
    'direct headless server did not require a safe manual service update'
  )
  stopContainer(server.name)
  console.log('PASS paired E2EE updater inventory and manual-service fallback')
}

async function startAndWait({
  image,
  launch,
  mode,
  address,
  port = '0',
  appPath = '/artifacts/squashfs-root/AppRun',
  networkAlias,
  noPairing = false,
  startupTimeoutMs = STARTUP_TIMEOUT_MS
}) {
  const name = `orca-pairing-${suffix}-${containers.size}`
  const args = [
    'run',
    '-d',
    '--init',
    '--shm-size',
    '256m',
    '--name',
    name,
    '--network',
    network,
    ...(networkAlias ? ['--network-alias', networkAlias] : []),
    '-e',
    'ORCA_KEEP_RUNNING=1',
    '-e',
    'LIBGL_ALWAYS_SOFTWARE=1',
    '-e',
    `ORCA_READY_JSON=${mode === 'json' ? '1' : '0'}`,
    '-e',
    `ORCA_PAIRING_ADDRESS=${address}`,
    '-e',
    `ORCA_SERVE_PORT=${port}`,
    '-e',
    `ORCA_TEST_APPIMAGE=${appPath}`,
    ...(noPairing ? ['-e', 'ORCA_NO_PAIRING=1'] : []),
    '-v',
    `${artifactVolume}:/artifacts:ro`,
    image.tag,
    launch
  ]
  docker(args)
  containers.add(name)
  const stdout = await waitForReady(name, startupTimeoutMs)
  return { name, stdout }
}

async function waitForReady(name, startupTimeoutMs) {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    const logResult = docker(['logs', name], { allowFailure: true })
    const stdout = `${logResult.stdout}${logResult.stderr}`
    if (hasCompleteReadyContract(stdout)) {
      return stdout
    }
    const running = docker(['inspect', '-f', '{{.State.Running}}', name], {
      allowFailure: true
    }).stdout.trim()
    if (running === 'false') {
      const containerLogs = docker(['logs', name], { allowFailure: true })
      throw new Error(
        `${name} exited before readiness:\n${containerLogs.stdout}${containerLogs.stderr}`
      )
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  const logResult = docker(['logs', name], { allowFailure: true })
  throw new Error(
    `${name} did not emit readiness within ${startupTimeoutMs}ms:\n${logResult.stdout}${logResult.stderr}`
  )
}

function hasCompleteReadyContract(stdout) {
  if (
    stdout.includes('Orca server ready\n') &&
    (stdout.includes('\nPairing URL: ') || stdout.includes('\nPairing guidance: '))
  ) {
    return true
  }
  return readyJsonObjects(stdout).length > 0
}

function readyJson(logs) {
  const matches = readyJsonObjects(logs)
  assert(matches.length === 1, `expected one ready JSON object, found ${matches.length}`)
  return matches[0]
}

function readyJsonObjects(logs) {
  const marker = '{"type":"orca_server_ready"'
  return logs
    .split(/\r?\n/)
    .map((line) => {
      const markerIndex = line.indexOf(marker)
      return markerIndex === -1 ? null : parseJson(line.slice(markerIndex))
    })
    .filter((value) => value?.type === 'orca_server_ready')
}

function runPairingClient(pairingUrl) {
  return docker(
    [
      'run',
      '--rm',
      '--network',
      network,
      '--entrypoint',
      '/artifacts/squashfs-root/AppRun',
      '-e',
      'APPDIR=/artifacts/squashfs-root',
      '-v',
      `${artifactVolume}:/artifacts:ro`,
      images[1].tag,
      '--no-sandbox',
      '--pairing-code',
      pairingUrl,
      'status',
      '--json'
    ],
    { allowFailure: true, timeout: 15_000 }
  )
}

function lastJsonObject(output) {
  return parseJson(output.trim()) ?? output.split(/\r?\n/).map(parseJson).findLast(Boolean) ?? null
}

function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function stopContainer(name) {
  docker(['stop', '--time', '5', name], { allowFailure: true })
  docker(['rm', name], { allowFailure: true })
  containers.delete(name)
}

function docker(args, options = {}) {
  try {
    const stdout = execFileSync('docker', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: options.allowFailure ? 'pipe' : ['ignore', 'pipe', 'inherit'],
      timeout: options.timeout
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const result = {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message)
    }
    if (!options.allowFailure) {
      throw new Error(`docker ${args[0]} failed:\n${result.stderr}\n${result.stdout}`)
    }
    return result
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
