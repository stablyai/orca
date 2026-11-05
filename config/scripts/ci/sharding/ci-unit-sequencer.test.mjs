import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import TimingSequencer from './ci-unit-sequencer.mjs'

let root
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  'valid',
  'stale',
  'missing-file',
  'missing-artifact',
  'outside-selection',
  'empty-selection'
])('preserves complete shard coverage with %s planning evidence', async (kind) => {
  root = mkdtempSync(join(tmpdir(), 'unit-sequencer-'))
  const files = [
    'src/main/foreign-sqlite-readers/foreign-sqlite-reader-event-loop.test.ts',
    'src/b.test.ts',
    'src/c.test.ts',
    'src/d.test.ts'
  ]
  const plan = {
    version: 1,
    sourceSha: kind === 'stale' ? 'old' : 'current',
    files: kind === 'missing-file' ? files.slice(1) : files,
    executionFiles:
      kind === 'outside-selection'
        ? ['src/unknown.test.ts']
        : kind === 'empty-selection'
          ? []
          : files.slice(0, 2)
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
    const specs = files.map((file, position) => ({
      moduleId: join(root, file),
      project: {
        name: position === 0 ? 'node-measurement' : position % 2 ? 'bun' : 'node-runtime',
        config: { sequence: { groupOrder: position === 0 ? 2 : 1 }, isolate: true }
      }
    }))
    assigned.push(...(await sequencer.shard(specs)).map((spec) => spec.moduleId))
    const manifest = JSON.parse(readFileSync(join(root, 'assignment.json'), 'utf8'))
    expect(manifest.selectedShard).toBe(index)
    expect(manifest.shards.flatMap((shard) => shard.files).sort()).toEqual(
      (kind === 'valid' ? files.slice(0, 2) : files).toSorted()
    )
  }
  expect(assigned.sort()).toEqual(
    (kind === 'valid' ? files.slice(0, 2) : files).map((file) => join(root, file)).sort()
  )
  expect(new Set(assigned).size).toBe(assigned.length)
})

it('validates a large selection without scanning the discovered array for each file', async () => {
  root = mkdtempSync(join(tmpdir(), 'unit-sequencer-scale-'))
  const files = Array.from({ length: 1600 }, (_, index) => `src/scale-${index}.test.ts`)
  const executionFiles = files.slice(800)
  const planPath = join(root, 'selection.json')
  writeFileSync(
    planPath,
    JSON.stringify({ version: 1, sourceSha: 'current', files, executionFiles })
  )
  vi.stubEnv('ORCA_UNIT_SELECTION_PLAN', planPath)
  vi.stubEnv('ORCA_SHARD_SOURCE_SHA', 'current')
  vi.stubEnv('ORCA_SHARD_MANIFEST', join(root, 'assignment.json'))
  const sequencer = new TimingSequencer({ config: { root, shard: { index: 1, count: 1 } } })
  const specs = files.map((file) => ({ moduleId: join(root, file) }))
  const includes = Array.prototype.includes
  let discoveredArrayScans = 0
  const scan = vi
    .spyOn(Array.prototype, 'includes')
    .mockImplementation(function (value, fromIndex) {
      if (
        this.length === files.length &&
        this[0] === files[0] &&
        typeof value === 'string' &&
        value.startsWith('src/scale-')
      ) {
        discoveredArrayScans += 1
      }
      return includes.call(this, value, fromIndex)
    })
  const selected = await sequencer.shard(specs)
  scan.mockRestore()
  expect(selected.map((spec) => spec.moduleId).sort()).toEqual(
    executionFiles.map((file) => join(root, file)).sort()
  )
  expect(discoveredArrayScans).toBe(0)
})
