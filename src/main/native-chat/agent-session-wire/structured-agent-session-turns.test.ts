import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('performCancel', () => {
  it('acknowledges only the request and leaves the running lifecycle row intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1 }
    )
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })

  it('stops background tasks without interrupting the foreground turn or writing a row', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-background-tasks',
      turnId: 'background-tasks',
      scope: 'background-tasks'
    })

    expect(result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith({ sessionId: 'session-1', fence: 1 })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })
})
