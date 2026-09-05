#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
const platform = valueAfter('--platform') ?? 'linux/amd64'
const signalTarget = valueAfter('--signal-target') ?? 'app'
const entrypoint = valueAfter('--entrypoint') ?? 'app'
const intDelivery = valueAfter('--int-delivery') ?? 'foreground-process-group'
const launcherExecOverlay = args.includes('--launcher-exec-overlay')
if (!appImageArg) {
  fail('Usage: run-headless-serve-shutdown-docker.mjs --appimage /path/to/orca.AppImage')
}
if (!['app', 'serving-electron'].includes(signalTarget)) {
  fail(`Unsupported --signal-target: ${signalTarget}`)
}
if (!['app', 'appimage', 'launcher'].includes(entrypoint)) {
  fail(`Unsupported --entrypoint: ${entrypoint}`)
}
if (!['pid', 'foreground-process-group'].includes(intDelivery)) {
  fail(`Unsupported --int-delivery: ${intDelivery}`)
}
if (intDelivery === 'foreground-process-group' && signalTarget !== 'app') {
  fail('--int-delivery foreground-process-group requires --signal-target app')
}
if (launcherExecOverlay && entrypoint !== 'launcher') {
  fail('--launcher-exec-overlay requires --entrypoint launcher')
}

const appImage = resolve(appImageArg)
const shutdownDockerDirectory = resolve('config', 'docker', 'headless-serve-shutdown')
const shutdownDockerfile = resolve(shutdownDockerDirectory, 'Dockerfile')
if (!existsSync(appImage)) {
  fail(`AppImage not found: ${appImage}`)
}

const suffix = `${process.pid}-${Date.now()}`
const image = `orca-headless-serve-shutdown:${suffix}`
const artifactVolume = `orca-headless-serve-shutdown-${suffix}`
const sha256 = createHash('sha256').update(readFileSync(appImage)).digest('hex')

try {
  docker([
    'build',
    '--platform',
    platform,
    '-f',
    shutdownDockerfile,
    '-t',
    image,
    shutdownDockerDirectory
  ])
  docker(['volume', 'create', artifactVolume])
  runDesktopStartupOracle({ image, appImage, platform })
  docker([
    'run',
    '--rm',
    '--platform',
    platform,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--entrypoint',
    'bash',
    '-v',
    `${appImage}:/input/orca.AppImage:ro`,
    '-v',
    `${artifactVolume}:/artifacts`,
    image,
    '-lc',
    [
      'trap \'status=$?; if [ "$status" -ne 0 ]; then cat /artifacts/appimage-help.log /artifacts/appimage-extract.log 2>/dev/null || true; fi; exit "$status"\' EXIT',
      'test -r /input/orca.AppImage && test -x /input/orca.AppImage || { echo "FAIL: AppImage bind must be readable and executable" >&2; exit 1; }',
      'timeout --kill-after=5s 15s /input/orca.AppImage --appimage-help > /artifacts/appimage-help.log 2>&1',
      'cd /artifacts',
      'timeout --kill-after=10s 120s /input/orca.AppImage --appimage-extract > /artifacts/appimage-extract.log 2>&1',
      'mv squashfs-root root',
      launcherExecOverlay
        ? "sed -i 's/^ELECTRON_RUN_AS_NODE=1 /export ELECTRON_RUN_AS_NODE=1\\nexec /' /artifacts/root/resources/bin/orca-ide"
        : ':',
      'chmod -R a+rX /artifacts/root',
      'rm /artifacts/appimage-help.log /artifacts/appimage-extract.log'
    ].join(' && ')
  ])

  console.log(
    JSON.stringify({
      type: 'appimage_under_test',
      appImage,
      sha256,
      platform,
      signalTarget,
      entrypoint,
      intDelivery,
      launcherExecOverlay
    })
  )
  const failedSignals = []
  for (const signal of ['INT', 'TERM']) {
    const result = docker(
      [
        'run',
        '--rm',
        '--init',
        '--platform',
        platform,
        '--shm-size',
        '256m',
        '--name',
        `orca-headless-serve-shutdown-${signal.toLowerCase()}-${suffix}`,
        '-e',
        `ORCA_SIGNAL_TARGET=${signalTarget}`,
        '-e',
        `ORCA_TEST_ENTRYPOINT=${entrypoint}`,
        '-e',
        `ORCA_INT_DELIVERY=${intDelivery}`,
        '-v',
        `${appImage}:/input/orca.AppImage:ro`,
        '-v',
        `${artifactVolume}:/artifacts:ro`,
        image,
        signal
      ],
      { allowFailure: true }
    )
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.status !== 0) {
      failedSignals.push(`${signal}:${result.status}`)
    }
  }
  if (failedSignals.length > 0) {
    fail(`Shutdown oracle failed: ${failedSignals.join(', ')}`)
  }
  console.log('Headless serve packaged shutdown Docker validation passed.')
} finally {
  docker(['volume', 'rm', artifactVolume], { allowFailure: true })
  docker(['image', 'rm', image], { allowFailure: true })
}

function runDesktopStartupOracle({ image, appImage, platform }) {
  console.log('Running original AppImage desktop startup oracle...')
  docker([
    'run',
    '--rm',
    '--init',
    '--platform',
    platform,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,exec,size=1g',
    '--shm-size',
    '256m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    'orca',
    '--entrypoint',
    '/usr/local/bin/run-appimage-desktop-startup-case',
    '-e',
    'ORCA_STARTUP_DIAGNOSTICS=1',
    '-v',
    `${appImage}:/input/orca.AppImage:ro`,
    image,
    '/input/orca.AppImage'
  ])
}

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function docker(dockerArgs, options = {}) {
  const result = spawnSync('docker', dockerArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
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
