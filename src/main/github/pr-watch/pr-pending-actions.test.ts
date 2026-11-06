import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { completePRPendingAction } from './pr-head-evaluation'
import { PRPendingActionResume } from './pr-pending-action-resume'
import { prWatchCandidate } from './pr-watch-types'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'chat-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const WORKSPACE = {
  repoId: 'r',
  repoPath: '/repo',
  checkoutPath: '/repo',
  repoKind: 'git' as const,
  branch: 'work',
  connectionId: null
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function shellCall(command: string, output: string): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name: 'shell',
    input: { command },
    state: 'completed',
    output: { head: output, byteLength: output.length, digest: 'd', truncated: false }
  }
}

function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
}

function count(table: string): number {
  const database = openTestJournalHostDatabase(root)
  return (database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** A fresh resume, as after a restart: nothing in memory, only the saved row. */
function resumeAfterRestart(): PRPendingActionResume {
  const database = openTestJournalHostDatabase(root)
  return new PRPendingActionResume({
    database,
    chatExists: () => true,
    chatWorkspace: async () => WORKSPACE,
    repositories: async () => [{ owner: 'acme', repo: 'repo' }],
    resolvePushRemote: async () => ({ host: 'github.com', owner: 'acme', repo: 'repo' }),
    readAfterPush: () => {},
    resolveCommitSha: async () => null,
    isCommitInPRHead: async () => false,
    complete: (row, verified) => completePRPendingAction(database, row, verified),
    logger: { warn: () => {} },
    now: () => clock
  })
}

describe('pending PR actions', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-pending-actions-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('recovers a call captured before a crash once, and never again', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      shellCall('gh pr create --fill', 'https://github.com/acme/repo/pull/7\n'),
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    // The host died before verifying: only the row committed with the call survives.
    expect(count('pr_pending_actions')).toBe(1)
    const first = resumeAfterRestart()
    first.drain()
    await vi.waitFor(() => expect(count('pr_chat_actions')).toBe(1))
    first.clear()
    const second = resumeAfterRestart()
    second.drain()
    second.clear()
    expect(count('pr_pending_actions')).toBe(0)
    expect(count('pr_chat_actions')).toBe(1)
  })

  it('captures nothing from an imported transcript', async () => {
    const journal = await openJournal()
    await journal.replaceEpochItems('legacy_import', 0, [
      {
        identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-0', ordinal: 0 },
        body: shellCall('gh pr create --fill', 'https://github.com/acme/repo/pull/3\n'),
        ownerFence: 0
      }
    ])
    expect(count('pr_pending_actions')).toBe(0)
  })

  it('records both actions of one call that pushes and opens a PR', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      shellCall(
        'git push origin HEAD:review && gh pr create --head review --fill',
        'To github.com:acme/repo.git\n * [new branch]      HEAD -> review\nhttps://github.com/acme/repo/pull/8\n'
      ),
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const resume = resumeAfterRestart()
    resume.drain()
    // The create alone doesn't complete the row; the push's PR read does, with both actions.
    const read = {
      number: 8,
      headRefName: 'review',
      headSha: '89abcde0000000000000000000000000000000ff',
      headRepo: { owner: 'acme', repo: 'repo' },
      prRepo: { owner: 'acme', repo: 'repo' }
    } as PRInfo
    await vi.waitFor(() => {
      resume.verifyRead(prWatchCandidate(WORKSPACE, null), read, clock)
      expect(count('pr_pending_actions')).toBe(0)
    })
    resume.clear()
    const kinds = openTestJournalHostDatabase(root)
      .db.prepare('SELECT kind FROM pr_chat_actions ORDER BY kind')
      .all() as { kind: string }[]
    expect(kinds.map((row) => row.kind)).toEqual(['opened', 'pushed'])
  })
})
