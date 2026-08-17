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

export function packagedNodePtyFloorDockerArgs({ workspaceDirectory, appDirectory }) {
  const relativeAppDirectory = workspaceRelativePath(workspaceDirectory, appDirectory)
  const containerAppDirectory = `/workspace/${relativeAppDirectory}`
  const command = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    `apt-get install -y -qq ${FLOOR_PACKAGES.join(' ')} >/dev/null`,
    `ELECTRON_RUN_AS_NODE=1 ${containerAppDirectory}/${LINUX_EXECUTABLE} ` +
      '/workspace/config/scripts/linux-packaged-node-pty-floor-child.cjs ' +
      `${containerAppDirectory}/resources`
  ].join(' && ')
  return [
    'run',
    '--rm',
    '--mount',
    `type=bind,src=${workspaceDirectory},dst=/workspace,readonly`,
    '--workdir',
    '/workspace',
    FLOOR_IMAGE,
    '/bin/bash',
    '-lc',
    command
  ]
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
  spawn = spawnSync
}) {
  if (process.platform !== 'linux') {
    throw new Error('linux-packaged-node-pty-floor-smoke-requires-linux')
  }
  const absoluteAppDirectory = resolve(workspaceDirectory, appDirectory)
  if (!existsSync(resolve(absoluteAppDirectory, LINUX_EXECUTABLE))) {
    throw new Error(`linux-packaged-node-pty-floor-executable-missing: ${absoluteAppDirectory}`)
  }
  const result = spawn(
    'docker',
    packagedNodePtyFloorDockerArgs({ workspaceDirectory, appDirectory }),
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  )
  if (result.error || result.signal || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      `status-${result.status}-signal-${result.signal ?? 'none'}`
    throw new Error(`linux-packaged-node-pty-floor-smoke-failed: ${detail}`)
  }
  process.stdout.write(result.stdout)
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  runPackagedNodePtyFloorSmoke({ appDirectory: parseAppDirectory(process.argv.slice(2)) })
}
