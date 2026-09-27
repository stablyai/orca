// A chat whose journal file is not a usable database: its reads refuse with the one code a client
// treats as final, instead of a raw SQLite message the pane would re-ask forever.

import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig | null = null

afterEach(async () => {
  await rig?.dispose()
  rig = null
})

async function corruptJournal(active: RestTestRig): Promise<void> {
  const dir = journalDirectoryFor(active.root, { workspaceId: 'workspace-1', sessionId: SESSION })
  await writeFile(journalDatabaseFile(dir), Buffer.alloc(8192, 7))
}

describe('an unloadable chat journal', () => {
  it('refuses a history read with agent_session_journal_unreadable on every ask', async () => {
    const active = await createRestTestRig()
    rig = active
    await foundRestTestChat(active)
    await active.restart()
    await corruptJournal(active)
    const restarted = await active.restart()

    await expect(restarted.history({ sessionId: SESSION, direction: 'tail' })).rejects.toThrow(
      /^agent_session_journal_unreadable$/
    )
    await expect(restarted.history({ sessionId: SESSION, direction: 'tail' })).rejects.toThrow(
      /^agent_session_journal_unreadable$/
    )
  })
})
