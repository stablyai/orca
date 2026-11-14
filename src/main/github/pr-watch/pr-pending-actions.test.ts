import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { prWatchStorage } from './pr-watch-storage'
import {
  openTestAgentSessionDatabase,
  withTestAgentSessionDatabase
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { PRPendingActionResumeDeps } from './pr-pending-action-types'
import { PRPendingActionResume } from './pr-pending-action-resume'
import { prInfoFixture } from './pr-watch-test-fixtures'
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

function shellCall(
  command: string,
  output: string,
  state: 'running' | 'completed' = 'completed'
): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name: 'shell',
    input: { command },
    state,
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

async function count(table: string): Promise<number> {
  return withTestAgentSessionDatabase(root, (db) =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
  )
}

/** A fresh resume, as after a restart: nothing in memory, only the saved row. */
async function resumeAfterRestart(
  overrides: Partial<PRPendingActionResumeDeps> = {}
): Promise<PRPendingActionResume> {
  const database = prWatchStorage(await openTestAgentSessionDatabase(root))
  return new PRPendingActionResume({
    database,
    chatExists: () => true,
    chatWorkspace: async () => WORKSPACE,
    repositories: async () => [{ owner: 'acme', repo: 'repo' }],
    resolvePushRemote: async () => ({ host: 'github.com', owner: 'acme', repo: 'repo' }),
    readAfterPush: async () => {},
    resolveCommitSha: async () => null,
    isCommitInPRHead: async () => false,
    settle: (row, indices, verified) => database.write({ kind: 'settle', row, indices, verified }),
    logger: { warn: () => {} },
    now: () => clock,
    ...overrides
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
    expect(await count('pr_pending_actions')).toBe(1)
    const first = await resumeAfterRestart()
    first.drain()
    await vi.waitFor(async () => expect(await count('pr_chat_actions')).toBe(1))
    first.clear()
    const second = await resumeAfterRestart()
    second.drain()
    second.clear()
    expect(await count('pr_pending_actions')).toBe(0)
    expect(await count('pr_chat_actions')).toBe(1)
  })

  it('captures a call whose finish commits inside a lifecycle batch', async () => {
    const journal = await openJournal()
    const identity = {
      provider: 'codex' as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      ordinal: 0
    }
    const body = shellCall('gh pr create --fill', 'https://github.com/acme/repo/pull/7\n')
    await journal.appendItem(identity, shellCall('gh pr create --fill', '', 'running'), {
      fence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(await count('pr_pending_actions')).toBe(0)
    // The turn's end settles the call in the same batch that ends the turn.
    await journal.appendLifecycleBatch({
      settlementId: 'turn-end',
      fence: 0,
      mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }]
    })
    expect(await count('pr_pending_actions')).toBe(1)
  })

  it('keeps each verified target while a sibling resolves, through restart and expiry', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      shellCall(
        'gh pr create --repo acme/repo --fill && gh pr create --repo me/repo --fill && git push origin HEAD:review',
        'https://github.com/acme/repo/pull/12\nhttps://github.com/me/repo/pull/12\n' +
          'To gh-work:acme/repo.git\n * [new branch]      HEAD -> review\n'
      ),
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const finishedAt = clock
    // The push's SSH alias can't be resolved yet; both created PRs are this checkout's own.
    const unresolved = {
      repositories: async () => [
        { owner: 'acme', repo: 'repo' },
        { owner: 'me', repo: 'repo' }
      ],
      resolvePushRemote: async () => null
    }
    const first = await resumeAfterRestart(unresolved)
    first.drain()
    await vi.waitFor(async () => expect(await count('pr_chat_actions')).toBe(2))
    first.clear()
    expect(await count('pr_pending_actions')).toBe(1)
    clock = finishedAt + 25 * 60 * 60_000
    const second = await resumeAfterRestart(unresolved)
    second.drain()
    await vi.waitFor(async () => expect(await count('pr_pending_actions')).toBe(0))
    second.clear()
    const owners = await withTestAgentSessionDatabase(root, (db) =>
      db.prepare('SELECT owner, number FROM pr_chat_actions ORDER BY owner').all()
    )
    expect(owners).toEqual([
      { owner: 'acme', number: 12 },
      { owner: 'me', number: 12 }
    ])
  })

  it('records nothing from a row resumed after its saved expiry', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      shellCall('gh pr create --fill', 'https://github.com/acme/repo/pull/7\n'),
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    let release = () => {}
    const resolved = new Promise<void>((resolve) => (release = resolve))
    // Resolution starts in time and succeeds only after the expiry passed.
    const resume = await resumeAfterRestart({
      repositories: async () => {
        await resolved
        return [{ owner: 'acme', repo: 'repo' }]
      }
    })
    resume.drain()
    clock += 25 * 60 * 60_000
    release()
    await vi.waitFor(async () => expect(await count('pr_pending_actions')).toBe(0))
    resume.clear()
    expect(await count('pr_chat_actions')).toBe(0)
  })

  it('captures nothing from an imported transcript', async () => {
    const journal = await openJournal()
    await journal.write({
      kind: 'epoch-replace',
      reason: 'legacy_import',
      fence: 0,
      items: [
        {
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-0', ordinal: 0 },
          body: shellCall('gh pr create --fill', 'https://github.com/acme/repo/pull/3\n'),
          ownerFence: 0
        }
      ]
    })
    expect(await count('pr_pending_actions')).toBe(0)
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
    const resume = await resumeAfterRestart()
    resume.drain()
    // The create alone doesn't complete the row; the push's PR read does, with both actions.
    const read = prInfoFixture({
      number: 8,
      headRefName: 'review',
      headSha: '89abcde0000000000000000000000000000000ff',
      headRepo: { owner: 'acme', repo: 'repo' },
      prRepo: { owner: 'acme', repo: 'repo' }
    })
    await vi.waitFor(async () => {
      await resume.verifyRead(prWatchCandidate(WORKSPACE, null), read, clock)
      expect(await count('pr_pending_actions')).toBe(0)
    })
    resume.clear()
    const kinds = await withTestAgentSessionDatabase(root, (db) =>
      db.prepare('SELECT kind FROM pr_chat_actions ORDER BY kind').all()
    )
    expect(kinds.map((row) => row.kind)).toEqual(['opened', 'pushed'])
  })
})
