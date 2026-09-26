import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

const SESSION = 'status-session'
const EVIDENCE: AgentChildWorkEvidence[] = [{ type: 'session-ended', observedAt: 5 }]
let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-children-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function feedWith(sink: StructuredAgentSessionStatusSink) {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, SESSION)
  })
  const session = indexedStatusFeedSession({ journal })
  return new StructuredAgentSessionStatusFeed({
    sessions: new Map([[SESSION, session]]),
    getRecord: () => null,
    now: () => 1_000,
    statusSink: () => sink
  })
}

describe('structured status feed child work', () => {
  it("hands a session's child work to the sink with the session's provider, once its row landed", async () => {
    const sink = { publish: vi.fn(), forget: vi.fn(), publishChildWork: vi.fn() }
    const feed = await feedWith(sink)
    feed.publishChildWork(SESSION, EVIDENCE)
    expect(sink.publishChildWork).not.toHaveBeenCalled()
    feed.publish(SESSION)
    feed.publishChildWork(SESSION, EVIDENCE)
    feed.publishChildWork('another-session', EVIDENCE)
    expect(sink.publishChildWork).toHaveBeenCalledExactlyOnceWith(
      makeStructuredAgentStatusSubject(
        {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree'
        },
        SESSION
      ),
      EVIDENCE,
      'codex'
    )
  })

  it('never lets a failing child-work sink throw into the provider stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const feed = await feedWith({
      publish: vi.fn(),
      forget: vi.fn(),
      publishChildWork: () => {
        throw new Error('store down')
      }
    })
    feed.publish(SESSION)
    expect(() => feed.publishChildWork(SESSION, EVIDENCE)).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
