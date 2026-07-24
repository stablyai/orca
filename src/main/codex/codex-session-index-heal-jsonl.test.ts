import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_CODEX_SESSION_INDEX_HEAL_JSONL_LINE_BYTES,
  readCodexSessionIndexHealJsonlRecords
} from './codex-session-index-heal-jsonl'

describe('Codex session index heal JSONL reader', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-heal-jsonl-'))
    roots.push(root)
    return join(root, 'ledger.jsonl')
  }

  it('accepts a valid record exactly at the per-line byte limit', () => {
    const path = makePath()
    const prefix = '{"padding":"'
    const suffix = '"}'
    const padding = 'x'.repeat(
      MAX_CODEX_SESSION_INDEX_HEAL_JSONL_LINE_BYTES - prefix.length - suffix.length
    )
    writeFileSync(path, `${prefix}${padding}${suffix}\n`)

    expect([...readCodexSessionIndexHealJsonlRecords(path)]).toEqual([{ padding }])
  })

  it('skips an oversized sparse line and resumes at the next record', () => {
    const path = makePath()
    writeFileSync(path, '{"ignored":"')
    truncateSync(path, MAX_CODEX_SESSION_INDEX_HEAL_JSONL_LINE_BYTES + 8 * 1024 * 1024)
    appendFileSync(path, '\n{"kept":true}\n')

    expect([...readCodexSessionIndexHealJsonlRecords(path)]).toEqual([{ kept: true }])
  })
})
