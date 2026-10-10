import { copyFileSync, lstatSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME } from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from '@orca/process-host'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

// Windows has no profile shell launcher; the native one keeps multiline message arguments intact.
export function stageOrcadWindowsCliLauncher(
  root,
  outputDir,
  target,
  host = { platform: process.platform }
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  const source = join(root, '.build', 'windows-cli-launcher', arch, 'orca.exe')
  if (host.platform === 'win32') {
    const compile = runProcessSync({
      program: process.execPath,
      args: [
        join(root, 'config/scripts/build-windows-cli-launcher.mjs'),
        '--arch',
        arch,
        '--output',
        source
      ],
      stdio: 'inherit',
      timeoutMs: null
    })
    if (compile.code !== 0) {
      throw new Error('Could not build the Orca server CLI launcher')
    }
  }
  if (!lstatSync(source, { throwIfNoEntry: false })) {
    throw new Error(
      `Orcad ${target} requires the Windows CLI launcher at ${source}. On Windows, run: ` +
        `node config/scripts/build-windows-cli-launcher.mjs --arch ${arch} --output ${source}`
    )
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Orcad ${target} CLI launcher has ${describePeMachine(machine)}`)
  }
  const launcher = join(outputDir, ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME)
  mkdirSync(dirname(launcher), { recursive: true })
  copyFileSync(source, launcher)
}
