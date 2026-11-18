import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readCompletedHangContext } from './hang-incident-snapshot'

it('keeps only complete recent context and sanitizes complete names before truncating', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-context-'))
  try {
    const path = join(dir, 'trace.ndjson')
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'effect-span',
        name: 'old-span',
        startTimeUnixNano: '1000000',
        endTimeUnixNano: '2000000'
      })}\n${'x'.repeat(40_000)}\n${JSON.stringify({
        type: 'effect-span',
        name: `git.exec password=${'a'.repeat(200)}`,
        startTimeUnixNano: '3000000',
        endTimeUnixNano: '4000000',
        attributes: { private: 'discard' }
      })}\n{"type":"effect-span","name":"incomplete`
    )
    expect(readCompletedHangContext(path)).toEqual([
      { name: 'git.exec [redacted:labeled-kv]', startedAt: 3, completedAt: 4 }
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
