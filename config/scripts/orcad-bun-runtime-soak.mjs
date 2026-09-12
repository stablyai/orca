#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { parseOrcadBunSoakOptions } from './orcad-bun-soak-budget.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeFilename = orcadBunRuntimeFilename(process.platform)
const runtime = join(root, 'out', 'orcad', runtimeFilename)
const options = parseOrcadBunSoakOptions(process.argv.slice(2), {
  ...process.env,
  ORCA_ORCAD_BUN_SOAK_CYCLES: process.env.ORCA_ORCAD_BUN_SOAK_CYCLES ?? '25'
})
const maxRssGrowthMib = options.maxRssGrowthBytes / 1024 / 1024
const probes = ['orcad-bun-pty-poc.mjs', 'orcad-bun-websocket-smoke.mjs']
const startedAt = Date.now()

if (!existsSync(runtime)) {
  throw new Error('The bundled orcad Bun runtime is missing; run `pnpm build:orcad` first')
}

for (const probe of probes) {
  const result = runProcessSync({
    program: runtime,
    args: [
      join(root, 'config', 'scripts', probe),
      '--cycles',
      String(options.cycles),
      '--max-rss-growth-mib',
      String(maxRssGrowthMib)
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`${probe} failed with exit code ${String(result.code)}`)
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    runtime: runtimeFilename,
    cyclesPerProbe: options.cycles,
    totalCycles: options.cycles * probes.length,
    probes,
    durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2))
  })}\n`
)
