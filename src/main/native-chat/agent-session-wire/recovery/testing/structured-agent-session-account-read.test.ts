import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { retireOutgrownStructuredAgentSessionChild } from '../structured-agent-session-outgrown-child'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function session(variable: string, signedOut = false) {
  const root = await mkdtemp(join(tmpdir(), 'orca-account-read-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: variable === 'CODEX_HOME' ? 'codex' : 'claude',
      providerHandle: null
    }
  })
  if (signedOut) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      {
        kind: 'status',
        ...agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'row', agentName: 'Codex' })
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  return {
    child: {
      phase: 'ready' as const,
      generation: 'generation-1',
      fence: 1,
      accountHome: { variable, path: '/accounts/a' }
    },
    journal
  }
}

const work = {
  currentWork: () => null,
  childWorkOpen: () => false,
  hasOpenDispatch: () => false,
  providerHoldsDispatch: () => false,
  childWork: () => []
}

it('refuses an unreadable Codex selection even when a signed-out child still owes work', async () => {
  const stopAgent = vi.fn(async () => {})
  await expect(
    retireOutgrownStructuredAgentSessionChild('session-1', await session('CODEX_HOME', true), {
      work: { ...work, hasOpenDispatch: () => true },
      launchAccountHome: async () => {
        throw new Error('Selected Codex account unavailable')
      },
      stopAgent,
      logger: { warn: vi.fn(), error: vi.fn() }
    })
  ).rejects.toThrow('Selected Codex account unavailable')
  expect(stopAgent).not.toHaveBeenCalled()
})

it('keeps the existing Claude child when account selection evidence cannot be read', async () => {
  const stopAgent = vi.fn(async () => {})
  await expect(
    retireOutgrownStructuredAgentSessionChild('session-1', await session('CLAUDE_CONFIG_DIR'), {
      work,
      launchAccountHome: async () => {
        throw new Error('Claude account evidence unreadable')
      },
      stopAgent,
      logger: { warn: vi.fn(), error: vi.fn() }
    })
  ).resolves.toBeUndefined()
  expect(stopAgent).not.toHaveBeenCalled()
})
