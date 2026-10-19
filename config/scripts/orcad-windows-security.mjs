import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from '../../src/shared/orcad-artifacts.ts'
import { windowsSecurityAddonOutput } from './build-windows-security-addon.mjs'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

/**
 * A Windows slot's ACL addon. Required, not optional: orcad's data-root privacy check fails
 * closed without it, so a slot missing it would never start on Windows.
 */
export function stageOrcadWindowsSecurity(
  root,
  outputDir,
  target,
  host = { platform: process.platform },
  compile = compileOrcadWindowsSecurity,
  options = {}
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  const source = windowsSecurityAddonOutput(root, arch)
  if (!existsSync(source)) {
    if (host.platform !== 'win32') {
      throw new Error(
        `Orcad ${target} requires the Windows security addon. On Windows, run: ` +
          `node config/scripts/build-windows-security-addon.mjs --arch=${arch}`
      )
    }
    compile(root, arch, options)
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Orcad ${target} Windows security addon has ${describePeMachine(machine)}`)
  }
  copyFileSync(source, join(outputDir, ORCAD_WINDOWS_SECURITY_FILENAME))
}

function compileOrcadWindowsSecurity(
  root,
  arch,
  { enabled = false, runtimePath, run = runProcessSync } = {}
) {
  const result = run({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-windows-security-addon.mjs'),
      `--arch=${arch}`,
      ...(enabled && runtimePath
        ? ['--reuse-prepared-runtime', `--node-runtime=${runtimePath}`]
        : [])
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`Windows security addon build for ${arch} failed with exit ${result.code}`)
  }
}
