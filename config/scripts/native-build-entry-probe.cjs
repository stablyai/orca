'use strict'

// Loads one native build dir in a fresh Node or Electron process: `<runtime> this.cjs <module> <dir>`.
// Why a child: a failed addon load can poison the process that attempted it.

const { accessSync, constants, existsSync } = require('node:fs')
const { join } = require('node:path')
const { assertNodePtyJobOwnership } = require('./node-pty-job-ownership.cjs')
const { assertWindowsProcessTreeCreationTime } = require('./windows-process-tree-creation-time.cjs')
const { nodePtyNativeModuleName } = require('./native-build-entry.cjs')

const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']

function probeNativeBuildDir(moduleName, dir) {
  if (moduleName === 'node-pty') {
    const nativeName = nodePtyNativeModuleName()
    const addonPath = join(dir, `${nativeName}.node`)
    const native = { dir, module: require(addonPath) }
    assertNodePtyJobOwnership({ nativeName, native, addonPath })
    if (process.platform === 'darwin') {
      accessSync(join(dir, 'spawn-helper'), constants.X_OK)
    }
    if (nativeName === 'conpty') {
      for (const filename of NODE_PTY_CONPTY_RUNTIME_FILES) {
        if (!existsSync(join(dir, 'conpty', filename))) {
          throw new Error(
            `node-pty ConPTY runtime file is missing: ${join(dir, 'conpty', filename)}`
          )
        }
      }
    }
    return
  }
  if (moduleName === '@vscode/windows-process-tree') {
    assertWindowsProcessTreeCreationTime({
      module: require(join(dir, 'windows_process_tree.node'))
    })
    return
  }
  throw new Error(`no probe for ${moduleName}`)
}

if (require.main === module) {
  const [moduleName, dir] = process.argv.slice(2)
  try {
    probeNativeBuildDir(moduleName, dir)
  } catch (error) {
    console.error(`${moduleName}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { probeNativeBuildDir }
