#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const outputRoot = resolve(argument('--out-dir') ?? join(root, 'out', 'orcad-matrix'))
for (const target of ORCAD_BUN_TARGETS) {
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config', 'scripts', 'build-orcad-bun.mjs'),
      '--target',
      target,
      '--out-dir',
      join(outputRoot, target)
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(
      `orcad Bun matrix build failed for ${target} with exit ${result.code ?? 'unknown'}`
    )
  }
}
process.stdout.write(`[build-orcad-bun-matrix] ok — ${ORCAD_BUN_TARGETS.length} targets\n`)
