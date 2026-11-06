// Unsupported row kinds require a newer reader; sequence mismatches are damage. Neither deletes history.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'

export function registerJournalUnknownRowKindTests(): void {
  let root: string
  const journals = createTrackedJournalOpener({ legacyInputs: true })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-newer-kind-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  function rowEnvelope(epoch: string, seq: number) {
    return { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch, seq, fence: 1, ts: 5_000 + seq }
  }

  function newerRow(epoch: string, seq: number, extra: Record<string, unknown> = {}) {
    return {
      ...rowEnvelope(epoch, seq),
      kind: 'future-mark',
      payload: { said: 'by a newer build', seq },
      ...extra
    }
  }

  describe('parsing a row of a kind this build does not know', () => {
    it('reads one in the envelope every row keeps as unreadable', () => {
      expect(parseJournalRow(JSON.stringify(newerRow('epoch-1', 7)))).toEqual({
        ok: false,
        unreadable: true
      })
    })
  })
}
