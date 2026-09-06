#!/usr/bin/env node
/**
 * E2E harness for the Linux serve auto-update flow.
 *
 * Boots an Orca AppImage under a real systemd (privileged container), wires a
 * local HTTP update feed to a second AppImage, then verifies the full handshake:
 *   request.json -> helper accepted -> census-gated stop -> swap -> VERSION ->
 *   systemctl start -> journal readiness -> result.json {phase:"ok"}.
 *
 * Requires: docker (or podman via DOCKER=), an orca-linux AppImage, and a
 * feed server reachable from the container. See --help for options.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import process from 'node:process'

const args = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
const platform = valueAfter('--platform') ?? 'linux/amd64'
const updateTimeout = valueAfter('--update-timeout') ?? '180'
const readinessTimeout = valueAfter('--readiness-timeout') ?? '60'
if (!appImageArg) {
  fail('Usage: run-headless-serve-update-docker.mjs --appimage /path/to/orca.AppImage')
}
const appImage = resolve(appImageArg)
const updateDockerDirectory = resolve('config', 'docker', 'headless-serve-update')
const updateDockerfile = resolve(updateDockerDirectory, 'Dockerfile')
if (!existsSync(appImage)) {
  fail(`AppImage not found: ${appImage}`)
}

const suffix = `${process.pid}-${Date.now()}`
const image = `orca-headless-serve-update:${suffix}`
const container = `orca-headless-serve-update-${suffix}`
const helperInstallScript = buildHelperInstallScript()

try {
  docker([
    'build',
    '--platform',
    platform,
    '-f',
    updateDockerfile,
    '-t',
    image,
    updateDockerDirectory
  ])
  runUpdateCase({ image, appImage, platform, helperInstallScript })
  console.log('Headless serve update Docker validation passed.')
} finally {
  docker(['rm', '-f', container], { allowFailure: true })
  docker(['image', 'rm', image], { allowFailure: true })
}

function buildHelperInstallScript() {
  // Why esbuild and not a direct import: the CLI modules import Electron-typed paths;
  // bundling to CJS in a temp file keeps the runner free of repo TS loading rules.
  const result = buildSync({
    entryPoints: [resolve('src', 'main', 'cli', 'serve-update-helper-installer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  })
  const tempModule = join(mkdtempSync(join(tmpdir(), 'orca-helper-install-')), 'installer.cjs')
  writeFileSync(tempModule, result.outputFiles[0].text)
  try {
    const require = createRequire(import.meta.url)
    const { buildServeUpdateHelperInstallScript } = require(tempModule)
    return buildServeUpdateHelperInstallScript({
      spoolDir: '/var/lib/orca-server-update',
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION',
      serviceUser: 'orca'
    })
  } finally {
    rmSync(dirname(tempModule), { recursive: true, force: true })
  }
}

function runUpdateCase({ image, appImage, platform, helperInstallScript }) {
  const appImageName = 'orca-update.AppImage'
  // Mounted at the exact path the case script's placeholder line expects.
  const helperInstallDir = mkdtempSync(join(tmpdir(), 'orca-helper-mount-'))
  const helperInstallMount = join(helperInstallDir, 'helper-install.sh')
  writeFileSync(helperInstallMount, helperInstallScript, { mode: 0o755 })
  console.log('Running headless serve update Docker case...')
  try {
    // Why /sbin/init: the case script drives systemctl, which needs systemd as PID 1;
    // the image ENTRYPOINT is the case script, so it runs via docker exec after boot.
    docker([
      'run',
      '-d',
      '--name',
      container,
      '--platform',
      platform,
      '--privileged',
      '--cgroupns=host',
      '--entrypoint',
      '/sbin/init',
      '-v',
      '/sys/fs/cgroup:/sys/fs/cgroup:rw',
      '-v',
      `${appImage}:/input/${appImageName}:ro`,
      '-v',
      `${helperInstallMount}:/tmp/helper-install.sh:ro`,
      image
    ])
    waitForSystemd(container)
    docker(
      [
        'exec',
        '-e',
        `ORCA_UPDATE_TIMEOUT=${updateTimeout}`,
        '-e',
        `ORCA_READINESS_TIMEOUT=${readinessTimeout}`,
        container,
        '/usr/local/bin/run-update-case'
      ],
      { timeoutMs: Number(updateTimeout) * 1000 }
    )
  } finally {
    rmSync(helperInstallDir, { recursive: true, force: true })
  }
}

function waitForSystemd(container) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const result = docker(['exec', container, 'systemctl', 'is-system-running'], {
      allowFailure: true
    })
    const state = (result.stdout || '').trim()
    if (state === 'running' || state === 'degraded') {
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  fail('systemd did not reach a running state within 120s')
}

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function docker(dockerArgs, options = {}) {
  const result = spawnSync('docker', dockerArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    fail(`docker ${dockerArgs[0]} failed with status ${result.status}`)
  }
  return result
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
  throw new Error(message)
}
