import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const temporary = mkdtempSync(join(tmpdir(), 'orca-script-child-process-'))
const output = join(temporary, 'child-process.mjs')
let implementation

try {
  await build({
    stdin: {
      contents: [
        `export { runProcessSync, spawnProcess } from ${JSON.stringify(join(root, 'src/shared/child-process/run-process.ts'))}`,
        `export { windowsPowerShellPath } from ${JSON.stringify(join(root, 'src/shared/child-process/windows-system-binary.ts'))}`
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'script-child-process-entry.ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: output,
    logLevel: 'silent'
  })
  implementation = await import(pathToFileURL(output).href)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

export const runProcessSync = implementation.runProcessSync
export const spawnProcess = implementation.spawnProcess
export const windowsPowerShellPath = implementation.windowsPowerShellPath
