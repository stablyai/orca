// What a restarted host owes each listed chat before anyone opens it: a status row from its saved
// copy when the journal still stands where that copy was taken, and otherwise one open, settled and
// closed again, off every reader's path.

import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
  type StructuredAgentSessionSavedStatus
} from '../../../shared/structured-agent-session-saved-status'
import { AgentSessionSavedStatusStore } from '../../runtime/agent-session-saved-status-store'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { HOST_TEST_NOW } from './structured-agent-session-host-test-data'
import {
  createStartupRig,
  isOpen,
  latestStatus,
  type StartupRig
} from './structured-agent-session-startup-pass-test-rig'

let rig: StartupRig

type HostLock = { serialize: (id: string, task: () => Promise<void>) => Promise<void> }

beforeEach(async () => {
  rig = await createStartupRig()
})

afterEach(async () => {
  await rig.dispose()
})

/** Every row the current run published for a session, in order. */
function rowsOf(sessionId: string) {
  return rig.statusEvents.flatMap((event) =>
    event.type === 'status' && event.session.sessionId === sessionId
      ? [event.session]
      : event.type === 'snapshot'
        ? event.sessions.filter((session) => session.sessionId === sessionId)
        : []
  )
}

function journalDir(sessionId: string): string {
  return journalDirectoryFor(rig.root, { workspaceId: 'workspace-1', sessionId })
}

/** A second run's send, then a crash with the turn still running and its child alive. */
async function crashMidTurn(sessionId: string, text: string): Promise<void> {
  const recorded: StructuredAgentSessionSavedStatus[] = []
  const host = await rig.boot({
    savedStatus: {
      read: (id) => rig.savedStatus.read(id),
      prune: (keep) => rig.savedStatus.prune(keep),
      record: (id, saved) => {
        recorded.push(saved)
        rig.savedStatus.record(id, saved)
      }
    }
  })
  await host.restoreStartupSessions()
  await rig.chat(sessionId, { message: text })
  // Every publish of the running turn has run, and the flush timer fired: whatever it left in the
  // saved copy is on disk.
  await new Promise((resolve) => setTimeout(resolve, 0))
  rig.savedStatus.flush()
  await rig.crash()
  // Only a settled chat is ever saved: a running turn writes nothing.
  expect(recorded.filter((saved) => saved.projection.status === 'working')).toEqual([])
}

describe('listing from a saved status', () => {
  it('lists a settled chat from its saved status without opening its journal (C1)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(0)
    expect(isOpen(rig, 'session-a')).toBe(false)
    expect(latestStatus(rig, 'session-a')).toMatchObject({
      sessionId: 'session-a',
      workspaceId: 'workspace-1',
      status: 'idle',
      latestPrompt: 'first question'
    })
  })

  it('opens a chat whose saved copy an older projection version wrote (C3)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const stale = AgentSessionSavedStatusStore.open(rig.root)
    const saved = stale.read('session-a')
    expect(saved?.v).toBe(STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION)
    stale.record('session-a', { ...saved!, v: saved!.v - 1 })
    stale.close()
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
  })

  it('shows a model switched while idle, read from the record rather than the saved copy (C4)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const host = await rig.boot()
    const record = rig.store.getRecord('session-a')
    await rig.store.replaceSessionOptions({
      sessionId: 'session-a',
      fence: record?.lease.runtimeFence ?? 0,
      options: { model: 'gpt-switched' },
      now: HOST_TEST_NOW
    })

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(0)
    expect(latestStatus(rig, 'session-a')).toMatchObject({ model: 'gpt-switched' })
  })

  it('serves a chat that never had a turn from its saved copy, as its open would (C5)', async () => {
    await rig.chat('session-a')
    await rig.quit()
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(0)
    expect(latestStatus(rig, 'session-a')).toMatchObject({ status: null, latestPrompt: '' })
  })

  it('publishes the saved row as a replay: no rename edge, no start, no completion (C6)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const onSessionStatusChanged = vi.fn()
    const completions = vi.fn()
    const host = await rig.boot({ onSessionStatusChanged })
    host.subscribeTurnCompletions({ id: 'completions', emit: completions })

    await host.restoreStartupSessions()

    const seen = onSessionStatusChanged.mock.calls.filter(
      ([summary]) => summary.sessionId === 'session-a'
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[1]).toEqual({ replay: true })
    expect(seen[0]?.[0].hostExecutionPhase).toBeUndefined()
    expect(completions).not.toHaveBeenCalled()
  })

  it('never lists a crashed turn from the settled copy before it (C2)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    await crashMidTurn('session-a', 'second question')
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
    expect(latestStatus(rig, 'session-a')).toMatchObject({
      status: 'idle',
      latestPrompt: 'second question'
    })
    // Never shown in between: neither the settled turn before it nor the turn as still running.
    expect(rowsOf('session-a').filter((row) => row.latestPrompt !== 'second question')).toEqual([])
    expect(rowsOf('session-a').filter((row) => row.status === 'working')).toEqual([])
    expect(rig.store.getRecord('session-a')?.lease.settlementRetryRequired).toBeUndefined()
  })

  it.each([
    ['saved', true],
    ['lost', false]
  ])(
    'lists what a quit mid-turn settled, never the finished turn before it, its save %s (C10)',
    async (_case, saves) => {
      await rig.chat('session-a', { message: 'first question' })
      await rig.quit()
      // A run whose saved-status writes never land: its entry stays at the first turn's position.
      const dropped = {
        read: (id: string) => rig.savedStatus.read(id),
        prune: (keep: (id: string) => boolean) => rig.savedStatus.prune(keep),
        record: () => {}
      }
      const second = await rig.boot(saves ? {} : { savedStatus: dropped })
      await second.restoreStartupSessions()
      await rig.chat('session-a', { message: 'second question' })
      await rig.quit()
      const host = await rig.boot()

      await host.restoreStartupSessions()

      expect(latestStatus(rig, 'session-a')).toMatchObject({ latestPrompt: 'second question' })
      expect(rowsOf('session-a').filter((row) => row.latestPrompt === 'first question')).toEqual([])
    }
  )

  it('drops saved copies of chats that no longer exist (C11)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const orphan = AgentSessionSavedStatusStore.open(rig.root)
    orphan.record('session-gone', { ...orphan.read('session-a')! })
    orphan.close()
    const host = await rig.boot()

    await host.restoreStartupSessions()
    rig.savedStatus.flush()

    expect(rig.savedStatus.read('session-gone')).toBeNull()
    expect(rig.savedStatus.read('session-a')).not.toBeNull()
  })

  it('keeps status and reads working when the saved-status store throws (C12)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const broken = {
      read: () => {
        throw new Error('saved status unreadable')
      },
      record: () => {
        throw new Error('saved status unwritable')
      },
      prune: () => {
        throw new Error('saved status unprunable')
      }
    }
    const host = await rig.boot({ savedStatus: broken })

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
    expect(latestStatus(rig, 'session-a')).toMatchObject({ latestPrompt: 'first question' })
    const page = await host.history({ sessionId: 'session-a', direction: 'tail' })
    expect(page.ok).toBe(true)
  })
})

describe('a saved row is what the open would publish (C9b)', () => {
  it('equals the row a real first open publishes for a settled chat', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const seededHost = await rig.boot()
    await seededHost.restoreStartupSessions()
    const seeded = latestStatus(rig, 'session-a')
    expect(rig.opensOf('session-a')).toBe(0)
    await rig.quit()
    const openedHost = await rig.boot({ savedStatus: undefined })

    await openedHost.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
    expect(latestStatus(rig, 'session-a')).toEqual(seeded)
  })

  it('opens a chat whose last run left a compaction prepared, and settles it', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    const host = await rig.boot()
    const fence = rig.store.getRecord('session-a')?.lease.runtimeFence ?? 0
    await rig.store.setConversationCommand('session-a', fence, {
      command: 'compact',
      state: 'unknown',
      phase: 'prepared',
      runtimeFence: fence,
      operationId: 'compact-op-1',
      callerKey: 'client-1'
    })

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
    expect(rig.store.getRecord('session-a')?.conversationCommand?.phase).toBe('committed')
  })
})

describe('what the pass opens', () => {
  it('keeps a chat with an unusable journal listed, opens it once, and refuses its read (L2, C8)', async () => {
    await rig.chat('session-a', { message: 'first question' })
    await rig.quit()
    await writeFile(journalDatabaseFile(journalDir('session-a')), Buffer.alloc(8192, 7))
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(rig.opensOf('session-a')).toBe(1)
    expect(latestStatus(rig, 'session-a')).toBeUndefined()
    expect(host.listPersistedSessionTabs(rig.store.listVisibleSessionIds())).toEqual([
      { sessionId: 'session-a', workspaceId: 'workspace-1', agent: 'codex' }
    ])
    await expect(host.history({ sessionId: 'session-a', direction: 'tail' })).rejects.toThrow(
      /^agent_session_journal_unreadable$/
    )
  })

  it('founds no journal for a listed chat that has none, and it still reads (L3)', async () => {
    await rig.chat('session-a')
    await rig.quit()
    await rm(journalDir('session-a'), { recursive: true, force: true })
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(existsSync(journalDatabaseFile(journalDir('session-a')))).toBe(false)
    expect(rig.opensOf('session-a')).toBe(0)
    const page = await host.history({ sessionId: 'session-a', direction: 'tail' })
    expect(page.ok && page.page.items).toEqual([])
  })

  it('neither lists nor opens a chat whose tab closes before its step (L7)', async () => {
    await rig.chat('session-a', { message: 'first' })
    await rig.chat('session-b', { message: 'second' })
    await rig.quit()
    const host = await rig.boot()
    // Queued on the chat's own lock ahead of the pass, as a close landing mid-pass would be.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private per-session lock, reached to order a close ahead of the pass.
    const { serialize } = host as unknown as HostLock
    const closed = serialize('session-b', () =>
      rig.store.setSessionTabVisibility('session-b', false)
    )

    await host.restoreStartupSessions()
    await closed

    expect(latestStatus(rig, 'session-a')).toMatchObject({ latestPrompt: 'first' })
    expect(latestStatus(rig, 'session-b')).toBeUndefined()
    expect(rig.opensOf('session-b')).toBe(0)
  })

  it('opens no chat whose tab closed between the status check and its open (L7)', async () => {
    await rig.chat('session-a', { message: 'first' })
    await rig.chat('session-b', { message: 'second' })
    await rig.crash()
    const reconcile = Promise.withResolvers<void>()
    const probing = Promise.withResolvers<void>()
    rig.probeOwner.mockImplementation(async () => {
      probing.resolve()
      await reconcile.promise
      return { outcome: 'pid-absent' }
    })
    const host = await rig.boot()

    const pass = host.restoreStartupSessions()
    await probing.promise
    await rig.store.setSessionTabVisibility('session-b', false)
    reconcile.resolve()
    await pass

    expect(rig.opensOf('session-a')).toBe(1)
    expect(rig.opensOf('session-b')).toBe(0)
  })
})
