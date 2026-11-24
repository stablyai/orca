import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasCodexWriterLock } from './codex-rollout-writer-lock'

const THREAD_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'
const STEM = `sessions/2026/11/18/rollout-2026-11-18T10-00-00-${THREAD_ID}.jsonl`
let home: string

afterEach(() => {
  if (home) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('hasCodexWriterLock', () => {
  it('requires positive lock-file evidence', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-codex-lock-'))
    expect(await hasCodexWriterLock([home], STEM)).toBe(false)

    const locks = join(home, 'thread-writer-locks')
    mkdirSync(locks, { recursive: true })
    writeFileSync(join(locks, `${THREAD_ID}.lock`), '')
    expect(await hasCodexWriterLock([home], STEM)).toBe(true)
  })
})
