import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME } from '../../src/shared/orcad-artifacts.ts'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

export function orcadWindowsCliLauncherSource(root, arch) {
  return join(root, '.build', 'windows-cli-launcher', arch, 'orca.exe')
}

/** A Windows slot's `orca` command; a Windows build host compiles a missing one. */
export function stageOrcadWindowsCliLauncher(
  root,
  outputDir,
  target,
  host = { platform: process.platform },
  compile = compileOrcadWindowsCliLauncher
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  const source = orcadWindowsCliLauncherSource(root, arch)
  if (!existsSync(source)) {
    if (host.platform !== 'win32') {
      throw new Error(
        `Orcad ${target} requires the native CLI launcher. On Windows, run: ` +
          `node config/scripts/build-windows-cli-launcher.mjs --arch ${arch} --output ${source}`
      )
    }
    compile(root, arch, source)
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Orcad ${target} CLI launcher has ${describePeMachine(machine)}`)
  }
  const destination = join(outputDir, ...ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

function compileOrcadWindowsCliLauncher(root, arch, output) {
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-windows-cli-launcher.mjs'),
      '--arch',
      arch,
      '--output',
      output
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`Windows CLI launcher build for ${arch} failed with exit ${result.code}`)
  }
}
