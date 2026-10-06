import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const temporary = mkdtempSync(join(tmpdir(), 'orca-guest-validation-'))
const output = join(temporary, 'validation.mjs')
let validation
try {
  await build({
    entryPoints: [join(root, 'src/shared/guest-tree-kill-artifacts.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: output,
    logLevel: 'silent'
  })
  validation = await import(pathToFileURL(output).href)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
export const {
  readGuestTreeKillManifest,
  assertGuestTreeKillArtifacts,
  assertStaticGuestTreeKillElf,
  guestTreeKillSha256,
  GUEST_TREE_KILL_BINARY,
  GUEST_TREE_KILL_PLATFORMS
} = validation
