// The stored status is a cache of its derivation: a row derived by other rules reads as missing and
// is derived again. This pins what the derivation writes for every corpus chat, so a change to it
// (or to the shared projection it reads) fails here until the rules version is bumped with it.

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createTrackedJournalOpener,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import { JOURNAL_SESSION_STATUS_RULES } from './journal-session-state'
import {
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from './journal-session-state-test-corpus'

// Recorded with the rules version: change both together, after checking the new rows are right.
const DERIVED = {
  rules: 1,
  digest: '29251b320d2adb45c62e68fd0025c9e6bc24b2f04f094e49b09e7052c6160a32'
}

const journals = createTrackedJournalOpener()
const roots: string[] = []

afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('derives the same row for every corpus chat as the recorded rules version', async () => {
  const rows: Record<string, unknown> = {}
  for (const name of JOURNAL_SESSION_STATE_CASES) {
    const root = await mkdtemp(join(tmpdir(), 'orca-status-rules-'))
    roots.push(root)
    let clock = 1_000
    const journal = await journals.open({
      identity: {
        sessionId: name,
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: `thread-${name}` }
      },
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => `epoch-${name}`,
      currentFence: () => CORPUS_FENCE
    })
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    rows[name] = readTestJournalSessionStatus(root, name)
  }
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex')

  expect(
    { rules: JOURNAL_SESSION_STATUS_RULES, digest },
    'The stored status derivation changed: bump JOURNAL_SESSION_STATUS_RULES and record the new digest'
  ).toEqual(DERIVED)
})
