#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtime = join(root, 'out', 'orcad', orcadBunRuntimeFilename(process.platform))
const script = process.argv[2]

if (!script) {
  throw new Error('Usage: run-orcad-bun-script.mjs <script> [...args]')
}
if (!existsSync(runtime)) {
  throw new Error('The bundled orcad Bun runtime is missing; run `pnpm build:orcad` first')
}

const result = runProcessSync({
  program: runtime,
  args: [resolve(script), ...process.argv.slice(3)],
  cwd: process.cwd(),
  // Preserve the Node executable that launched this wrapper for migration
  // scripts which intentionally exercise a Node→Bun→Node sequence.
  env: { ...process.env, ORCA_BUN_SCRIPT_HOST_NODE: process.execPath },
  stdio: 'inherit',
  timeoutMs: null
})
if (result.signal) {
  throw new Error(`The bundled Bun script exited on ${result.signal}`)
}
process.exitCode = result.code ?? 1
