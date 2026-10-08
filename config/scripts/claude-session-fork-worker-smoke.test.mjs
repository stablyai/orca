import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeClaudeSessionForkWorker } from './claude-session-fork-worker-smoke.mjs'
import {
  buildOrcadChildEntry,
  externalNativeAddons,
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_EXTERNAL_MODULES
} from './orcad-entry-build.mjs'

const ENTRY = 'claude-session-fork-worker-entry.js'
const SOURCE = resolve(ORCAD_CHILD_ENTRY_POINTS.claudeSessionForkWorker)
const directories = []
let builtDirectory

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-claude-fork-smoke-test-'))
  directories.push(directory)
  return directory
}

beforeAll(async () => {
  builtDirectory = fixtureDirectory()
  await buildOrcadChildEntry(SOURCE, join(builtDirectory, ENTRY))
}, 60_000)

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Claude session fork worker build smoke', () => {
  it('copies a transcript through the entry orcad ships, with the SDK bundled into it', () => {
    expect(() => smokeClaudeSessionForkWorker(builtDirectory)).not.toThrow()
  })

  it('fails when the entry is missing', () => {
    expect(() => smokeClaudeSessionForkWorker(fixtureDirectory())).toThrow('smoke failed')
  })

  it('fails for a bundle whose SDK cannot find its own URL', async () => {
    const directory = fixtureDirectory()
    // The same bundle without the module-URL definition the shipped build gives it.
    await build({
      entryPoints: [SOURCE],
      outfile: join(directory, ENTRY),
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      external: ORCAD_EXTERNAL_MODULES,
      plugins: [externalNativeAddons],
      logLevel: 'silent'
    })

    expect(() => smokeClaudeSessionForkWorker(directory)).toThrow('smoke failed')
  }, 60_000)
})
