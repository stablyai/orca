// Stage pinned Linux Node before glibc-floor checks; deb/rpm remove it via fpm, while AppImage needs it because mounted files can vanish.
const { chmodSync, copyFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  APPIMAGE_NODE_RUNTIME_FPM_EXCLUDE,
  APPIMAGE_NODE_RUNTIME_SEGMENTS,
  appImageNodeRuntimeTarget
} = require('../../src/shared/appimage-node-runtime.ts')
const { runTerminalHostRoundTrip } = require('./verify-packaged-daemon-entry.cjs')

const appImageNodeRuntimeFpmArgs = ['--exclude', APPIMAGE_NODE_RUNTIME_FPM_EXCLUDE]
const PTY_ROUND_TRIP_TIMEOUT_MS = 20_000

async function ensurePinnedNode(target) {
  const { ensurePinnedNodeExecutable } = await import(
    pathToFileURL(resolve(__dirname, 'pinned-node-downloads.mjs')).href
  )
  return ensurePinnedNodeExecutable({ target })
}

/** `arch` is a Node arch name; the copy is hash-checked by the pinned download it comes from. */
async function placeAppImageNodeRuntime(resourcesDir, arch, ensureNode = ensurePinnedNode) {
  const target = appImageNodeRuntimeTarget(arch)
  if (!target) {
    throw new Error(`[appimage-node-runtime] the Node pin has no glibc build for Linux ${arch}`)
  }
  const destination = join(resourcesDir, ...APPIMAGE_NODE_RUNTIME_SEGMENTS)
  mkdirSync(join(destination, '..'), { recursive: true })
  copyFileSync(await ensureNode(target), destination)
  chmodSync(destination, 0o755)
  return destination
}

/** The bundled Node must load the packaged node-pty and serve one PTY, as the daemon will. */
async function verifyAppImageNodeRuntimeServesPty(resourcesDir, runtimePath) {
  const stderr = []
  try {
    await runTerminalHostRoundTrip({
      command: [runtimePath],
      entry: join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js'),
      deadline: Date.now() + PTY_ROUND_TRIP_TIMEOUT_MS,
      stderr
    })
  } catch (error) {
    throw new Error(
      `[appimage-node-runtime] the bundled Node did not serve a PTY: ${error.message}\n${stderr.join('').slice(-2000)}`
    )
  }
  console.log('[appimage-node-runtime] OK — the bundled Node served a PTY')
}

module.exports = {
  appImageNodeRuntimeFpmArgs,
  placeAppImageNodeRuntime,
  verifyAppImageNodeRuntimeServesPty
}
