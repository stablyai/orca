import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { RelaySealedEntries } from './relay-sealed-entries'

type Run = { sessionId: string; runFence: number; sealed: string }
const isRun = (value: unknown): value is Run =>
  typeof jsonProperty(value, 'sessionId') === 'string' &&
  typeof jsonProperty(value, 'runFence') === 'number' &&
  typeof jsonProperty(value, 'sealed') === 'string'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const at = (dir: string) =>
  new RelaySealedEntries<Run>(dir, isRun, (run) => `${run.sessionId}\n${run.runFence}`)

describe('kept relay entries on disk', () => {
  it('round-trips each entry in its own file, in order of its changes, across runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-entries-'))
    dirs.push(root)
    const dir = join(root, 'shared-tool-callers')
    const first = at(dir)
    // Unawaited changes to one entry land in order: the last one wins.
    void first.put({ sessionId: 'a', runFence: 1, sealed: 'old' })
    void first.put({ sessionId: 'a', runFence: 1, sealed: 'new' })
    await first.put({ sessionId: '../b', runFence: 2, sealed: 'b' })
    await first.put({ sessionId: 'c', runFence: 3, sealed: 'c' })
    await first.delete({ sessionId: 'c', runFence: 3, sealed: 'c' })
    // A crashed earlier run's temp file and a file under another entry's name are never read.
    writeFileSync(join(dir, 'x.json.1.2.3.tmp'), '{}')
    const named = readdirSync(dir).find((name) => name.endsWith('.json'))
    writeFileSync(
      join(dir, `${'0'.repeat(64)}.json`),
      JSON.stringify({ version: 1, entry: { sessionId: 'z', runFence: 9, sealed: 'z' } })
    )

    const read = await at(dir).read()
    expect(read.toSorted((x, y) => x.runFence - y.runFence)).toEqual([
      { sessionId: 'a', runFence: 1, sealed: 'new' },
      { sessionId: '../b', runFence: 2, sealed: 'b' }
    ])
    expect(named).toMatch(/^[0-9a-f]{64}\.json$/)
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
