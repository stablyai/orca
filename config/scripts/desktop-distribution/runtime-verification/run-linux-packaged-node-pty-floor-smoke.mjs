import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const FLOOR_IMAGE = 'ubuntu:20.04'
const LINUX_EXECUTABLE = 'orca-ide'
const FLOOR_PACKAGES = [
  'ca-certificates',
  'libasound2',
  'libatspi2.0-0',
  'libdrm2',
  'libgbm1',
  'libgtk-3-0',
  'libnss3',
  'libx11-xcb1',
  'libxkbcommon0',
  'libxss1'
]

function workspaceRelativePath(workspaceDirectory, inputPath) {
  const absolutePath = resolve(workspaceDirectory, inputPath)
  const relativePath = relative(workspaceDirectory, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('linux-packaged-node-pty-floor-app-directory-invalid')
  }
  return relativePath.split(sep).join('/')
}

// Why: a stalled phase must fail in about a minute and name itself, not burn the 10-minute step timeout.
const PHASE_TIMEOUT_SECONDS = {
  'docker-pull': 120,
  'apt-update': 90,
  'apt-install': 150,
  'node-pty-load': 30
}
const PHASE_KILL_GRACE_SECONDS = 5
const APT_OPTIONS =
  '-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20'

function containerTimeoutMs() {
  const { 'docker-pull': _pull, ...containerPhases } = PHASE_TIMEOUT_SECONDS
  const phaseSeconds = Object.values(containerPhases).reduce(
    (total, seconds) => total + seconds + PHASE_KILL_GRACE_SECONDS,
    0
  )
  return (phaseSeconds + 30) * 1000
}

function containerPhase(phase, command) {
  const seconds = PHASE_TIMEOUT_SECONDS[phase]
  return (
    `echo "[node-pty-floor] phase=${phase} start (limit ${seconds}s)" >&2; ` +
    `timeout -k ${PHASE_KILL_GRACE_SECONDS} ${seconds} ${command} || fail ${phase} $?`
  )
}

// Why: from GitHub's x64 runners archive/security.ubuntu.com can crawl for minutes; the runner
// image's own Azure mirror serves the same focal pockets at once.
function aptMirrorCommands(aptMirror) {
  if (!aptMirror) {
    return []
  }
  if (!/^https?:\/\/[\w.-]+(\/[\w.-]+)*\/?$/.test(aptMirror)) {
    throw new Error(`linux-packaged-node-pty-floor-apt-mirror-invalid: ${aptMirror}`)
  }
  const mirror = aptMirror.replace(/\/$/, '')
  return [
    `sed -i -E 's#http://(archive|security)\\.ubuntu\\.com/ubuntu/?#${mirror}/#' /etc/apt/sources.list`
  ]
}

export function packagedNodePtyFloorDockerArgs({
  workspaceDirectory,
  appDirectory,
  containerName,
  aptMirror
}) {
  const relativeAppDirectory = workspaceRelativePath(workspaceDirectory, appDirectory)
  const containerAppDirectory = `/workspace/${relativeAppDirectory}`
  const command = [
    'export DEBIAN_FRONTEND=noninteractive',
    'fail() { echo "linux-packaged-node-pty-floor-phase-failed: phase=$1 status=$2 (124 = timed out)" >&2; exit 1; }',
    ...aptMirrorCommands(aptMirror),
    // Why: not quiet, so a stall shows which repository apt is waiting on.
    containerPhase('apt-update', `apt-get ${APT_OPTIONS} update`),
    containerPhase(
      'apt-install',
      `apt-get ${APT_OPTIONS} install -y -qq ${FLOOR_PACKAGES.join(' ')} >/dev/null`
    ),
    containerPhase(
      'node-pty-load',
      `env ELECTRON_RUN_AS_NODE=1 ${containerAppDirectory}/${LINUX_EXECUTABLE} ` +
        '/workspace/config/scripts/desktop-distribution/runtime-verification/linux-packaged-node-pty-floor-child.cjs ' +
        `${containerAppDirectory}/resources`
    )
  ].join('\n')
  return [
    'run',
    '--rm',
    ...(containerName ? ['--name', containerName] : []),
    '--mount',
    `type=bind,src=${workspaceDirectory},dst=/workspace,readonly`,
    '--workdir',
    '/workspace',
    FLOOR_IMAGE,
    '/bin/bash',
    '-c',
    command
  ]
}

function describeSpawnFailure(phase, result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT') {
    return `linux-packaged-node-pty-floor-phase-timeout: phase=${phase} after ${timeoutMs / 1000}s`
  }
  const detail =
    result.error?.message || `status-${result.status}-signal-${result.signal ?? 'none'}`
  return `linux-packaged-node-pty-floor-smoke-failed: phase=${phase} ${detail}`
}

function parseAppDirectory(argv) {
  const index = argv.indexOf('--app-dir')
  const value = index !== -1 ? argv[index + 1] : undefined
  if (!value || isAbsolute(value) || value.startsWith('-')) {
    throw new Error('Usage: run-linux-packaged-node-pty-floor-smoke.mjs --app-dir <relative-path>')
  }
  return value
}

export function runPackagedNodePtyFloorSmoke({
  workspaceDirectory = process.cwd(),
  appDirectory,
  aptMirror = process.env.ORCA_NODE_PTY_FLOOR_APT_MIRROR,
  spawn = spawnSync
}) {
  if (process.platform !== 'linux') {
    throw new Error('linux-packaged-node-pty-floor-smoke-requires-linux')
  }
  const absoluteAppDirectory = resolve(workspaceDirectory, appDirectory)
  if (!existsSync(resolve(absoluteAppDirectory, LINUX_EXECUTABLE))) {
    throw new Error(`linux-packaged-node-pty-floor-executable-missing: ${absoluteAppDirectory}`)
  }
  const pullTimeoutMs = PHASE_TIMEOUT_SECONDS['docker-pull'] * 1000
  process.stderr.write(
    `[node-pty-floor] phase=docker-pull start (limit ${pullTimeoutMs / 1000}s)\n`
  )
  const pull = spawn('docker', ['pull', '--quiet', FLOOR_IMAGE], {
    stdio: 'inherit',
    timeout: pullTimeoutMs,
    killSignal: 'SIGKILL'
  })
  if (pull.error || pull.signal || pull.status !== 0) {
    throw new Error(describeSpawnFailure('docker-pull', pull, pullTimeoutMs))
  }
  const containerName = `orca-node-pty-floor-${process.pid}-${Date.now()}`
  const timeoutMs = containerTimeoutMs()
  // Why: stream output live so a stall shows the last phase reached in the job log.
  const result = spawn(
    'docker',
    packagedNodePtyFloorDockerArgs({ workspaceDirectory, appDirectory, containerName, aptMirror }),
    { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' }
  )
  if (result.error || result.signal || result.status !== 0) {
    // Why: killing the docker CLI leaves the container running; remove it so a retry starts clean.
    spawn('docker', ['rm', '--force', containerName], { stdio: 'ignore', timeout: 30_000 })
    throw new Error(describeSpawnFailure('container', result, timeoutMs))
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  runPackagedNodePtyFloorSmoke({ appDirectory: parseAppDirectory(process.argv.slice(2)) })
}
