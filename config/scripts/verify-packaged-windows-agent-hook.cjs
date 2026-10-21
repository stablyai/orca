'use strict'

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')

// electron-builder's `Arch` enum values for the Windows slices Orca can package.
const ARCH_BY_ELECTRON_BUILDER_ENUM = { 1: 'x64', 3: 'arm64' }

/**
 * Fails packaging when the native agent hook is absent or built for another machine.
 * Why here: electron-builder only warns on a missing extraResources source, and an
 * install without the hook silently keeps every user on the slower `.cmd` form.
 */
function verifyPackagedWindowsAgentHook(resourcesDir, electronBuilderArch) {
  const hookPath = join(resourcesDir, 'bin', 'orca-agent-hook.exe')
  if (!existsSync(hookPath)) {
    throw new Error(
      `Missing packaged agent hook ${hookPath}; run node config/scripts/build-windows-agent-hook.mjs`
    )
  }
  const arch = ARCH_BY_ELECTRON_BUILDER_ENUM[electronBuilderArch]
  const machine = readPeMachine(hookPath)
  if (arch === undefined || machine !== PE_MACHINE[arch]) {
    throw new Error(
      `Packaged agent hook for ${arch ?? `arch ${electronBuilderArch}`} has ${describePeMachine(machine)}`
    )
  }
}

module.exports = { verifyPackagedWindowsAgentHook }
