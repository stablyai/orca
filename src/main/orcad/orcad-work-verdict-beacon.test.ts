import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startOrcadWorkVerdictBeacon, writeWorkVerdictBeacon } from './orcad-work-verdict-beacon'

describe('orcad work verdict beacon', () => {
  it('writes the verdict with a timestamp the control plane can judge freshness by', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'orcad-beacon-')),
      '.orca-sandbox',
      'work-verdict.json'
    )
    await writeWorkVerdictBeacon(
      path,
      { verdict: 'busy', idleSince: null, lastPtyInputAt: 5 },
      1_000
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      verdict: 'busy',
      idleSince: null,
      lastPtyInputAt: 5,
      at: 1_000
    })
  })

  it('stays off outside an Orca Cloud sandbox', () => {
    let reads = 0
    const stop = startOrcadWorkVerdictBeacon(
      () => null,
      {},
      async () => {
        reads++
        return { verdict: 'idle', idleSince: 1, lastPtyInputAt: null }
      }
    )
    stop()
    expect(reads).toBe(0)
  })
})
