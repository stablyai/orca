import { copyFileSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/orcad-artifacts.ts'
import {
  inspectWindowsProcessTreeAddon,
  windowsProcessTreeAddonPath
} from './windows-process-tree-gyp-rebuild.mjs'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

export function stageOrcadWindowsProcessTree(
  root,
  outputDir,
  target,
  host = { platform: process.platform, arch: process.arch }
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  let source = join(
    root,
    '.build',
    'windows-process-tree',
    arch,
    ORCAD_WINDOWS_PROCESS_TREE_FILENAME
  )
  // Ordinary Windows installs already compile this N-API addon for the host.
  if (target === `${host.platform}-${host.arch}` && !lstatSync(source, { throwIfNoEntry: false })) {
    source = windowsProcessTreeAddonPath(
      join(root, 'node_modules', '@vscode', 'windows-process-tree')
    )
  }
  if (inspectWindowsProcessTreeAddon(source) !== 'clean') {
    throw new Error(
      `Orcad ${target} requires a patched process reader. On Windows, run: ` +
        `node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=${arch}`
    )
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Orcad ${target} process reader has ${describePeMachine(machine)}`)
  }
  copyFileSync(source, join(outputDir, ORCAD_WINDOWS_PROCESS_TREE_FILENAME))
}
