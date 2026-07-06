const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

// Where the standalone daemon-host node.exe is staged under packaged resources.
// Mirrored at runtime by src/main/daemon/daemon-host-relocation.ts, which copies
// it into userData/daemon-host/<version>/ and forks the terminal daemon from it.
const DAEMON_HOST_DIR = 'daemon-host'
const DAEMON_HOST_NODE_EXE = 'node.exe'

/**
 * Stages a standalone Windows node.exe into resources/daemon-host so the
 * detached terminal daemon can be forked from a userData copy that lives
 * outside the install directory the NSIS updater force-closes mid-update.
 *
 * Source is the build host's own node.exe (process.execPath). It is version-
 * correct by construction: engines.node pins the build to Node 24.x, whose NAPI
 * 10 runtime loads node-pty's Electron-42-built conpty.node. Being an official
 * Node binary, it also carries the OpenJS Foundation Authenticode signature, so
 * it ships validly signed regardless of whether SignPath re-signs nested PEs.
 *
 * Windows x64 only — the sole Windows build target. Other targets ship no
 * node.exe and the runtime falls open to forking the install-dir Electron host.
 */
function ensurePackagedDaemonHostNode(resourcesDir, electronPlatformName) {
  if (electronPlatformName !== 'win32') {
    return
  }
  const nodeExePath = process.execPath
  // The build must run under standalone Node (not Electron) so execPath is a
  // real node.exe with a NAPI runtime; anything else would strand the daemon.
  if (!/node\.exe$/i.test(nodeExePath) || !existsSync(nodeExePath)) {
    throw new Error(
      `[daemon-host] cannot stage node.exe: build host execPath is not a node.exe (${nodeExePath})`
    )
  }
  const destDir = join(resourcesDir, DAEMON_HOST_DIR)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(nodeExePath, join(destDir, DAEMON_HOST_NODE_EXE))
}

module.exports = { ensurePackagedDaemonHostNode, DAEMON_HOST_DIR, DAEMON_HOST_NODE_EXE }
