import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import TimingSequencer from './ci-unit-sequencer.mjs'

let root
afterEach(() => {
  vi.unstubAllEnvs()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['valid', 'stale', 'missing-file', 'missing-artifact'])(
  'preserves complete shard coverage with %s planning evidence',
  async (kind) => {
    root = mkdtempSync(join(tmpdir(), 'unit-sequencer-'))
    const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']
    const plan = {
      version: 1,
      sourceSha: kind === 'stale' ? 'old' : 'current',
      files: kind === 'missing-file' ? files.slice(1) : files,
      executionFiles: files.slice(0, 2)
    }
    const planPath = join(root, 'selection.json')
    if (kind !== 'missing-artifact') {
      writeFileSync(planPath, JSON.stringify(plan))
    }
    vi.stubEnv('ORCA_UNIT_SELECTION_PLAN', planPath)
    vi.stubEnv('ORCA_SHARD_SOURCE_SHA', 'current')
    vi.stubEnv('ORCA_SHARD_MANIFEST', join(root, 'assignment.json'))
    const assigned = []
    for (const index of [1, 2]) {
      const sequencer = new TimingSequencer({ config: { root, shard: { index, count: 2 } } })
      const specs = files.map((file) => ({ moduleId: join(root, file) }))
      assigned.push(...(await sequencer.shard(specs)).map((spec) => spec.moduleId))
    }
    expect(assigned.sort()).toEqual(
      (kind === 'valid' ? files.slice(0, 2) : files).map((file) => join(root, file)).sort()
    )
    expect(new Set(assigned).size).toBe(assigned.length)
  }
)
