import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'

const { restoreRead } = vi.hoisted(() => ({
  restoreRead: vi.fn()
}))

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: restoreRead
}))

import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

// The restore under test is mocked; the host database only fills the deps' shape.
const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-restart-restore-'))
afterAll(() => {
  closeTestJournalHostDatabases()
  rmSync(stateDirectory, { recursive: true, force: true })
})

const NO_OPEN_DEPS = {
  store: { getRecord: () => null, listRecords: () => [], replacedRuntime: () => undefined },
  journalDatabase: openTestJournalHostDatabase(stateDirectory),
  logger: recordingStructuredAgentSessionLogger().logger
}

describe('restart journal restoration', () => {
  beforeEach(() => restoreRead.mockReset())

  it('bounds historical journal parsing to four sessions at a time', async () => {
    const gate = Promise.withResolvers<void>()
    let active = 0
    let peak = 0
    restoreRead.mockImplementation(async (_deps, sessionId: string) => {
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      return {
        session: {
          journal: {},
          params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' },
          child: null,
          sessionId
        }
      }
    })
    const records = Array.from(
      { length: 12 },
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    const restoration = restoreStructuredAgentSessionsOnRestart({
      openDeps: NO_OPEN_DEPS,
      records,
      reconcile: async () => true,
      resolveRecovery: async () => true,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined
    })

    await vi.waitFor(() => expect(active).toBe(4))
    expect(restoreRead).toHaveBeenCalledTimes(4)
    gate.resolve()
    await restoration

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    expect(peak).toBe(4)
  })

  it('lets the event loop run between chats', async () => {
    // Counts turns of the event loop while the restore runs; each open below is synchronous.
    let turns = 0
    let ticking = true
    const tick = (): void => {
      turns += 1
      if (ticking) {
        setImmediate(tick)
      }
    }
    setImmediate(tick)
    const turnsSeen = new Set<number>()
    restoreRead.mockImplementation(async () => {
      turnsSeen.add(turns)
      return null
    })
    const records = Array.from(
      { length: 12 },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    await restoreStructuredAgentSessionsOnRestart({
      openDeps: NO_OPEN_DEPS,
      records,
      reconcile: async () => true,
      resolveRecovery: async () => true,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined
    })
    ticking = false

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    // At most one chat per worker between two turns: never the whole restore in one task.
    expect(turnsSeen.size).toBeGreaterThanOrEqual(records.length / 4)
  })

  it('settles what a gone generation left running after recovery resolution, before publishing', async () => {
    const calls: string[] = []
    const params: AgentSessionAttachParams = {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'read-restore:session-1',
        expectedRuntimeFence: 4,
        payloadFingerprint: 'fingerprint'
      },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
      runtimeKind: 'native'
    }
    const restored = {
      session: { journal: {}, params, child: null }
    }
    // The open is what settles: it runs after recovery resolution and before the publish.
    restoreRead.mockImplementation(async () => {
      calls.push('open')
      return restored
    })

    await restoreStructuredAgentSessionsOnRestart({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      records: [{ sessionId: 'session-1' } as AgentSessionRecord],
      openDeps: NO_OPEN_DEPS,
      reconcile: async () => true,
      resolveRecovery: async () => {
        calls.push('resolveRecovery')
        return true
      },
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: (_sessionId, readable) => {
        calls.push(readable === restored ? 'onReadable:restored' : 'onReadable')
      }
    })

    expect(calls).toEqual(['resolveRecovery', 'open', 'onReadable:restored'])
  })

  // Each failed bookkeeping call stands for one refused store write.
  describe('once lease bookkeeping fails in a pass', () => {
    const records = Array.from(
      { length: 8 },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )
    const restore = (
      bookkeeping: Pick<
        Parameters<typeof restoreStructuredAgentSessionsOnRestart>[0],
        'reconcile' | 'resolveRecovery'
      >
    ) =>
      restoreStructuredAgentSessionsOnRestart({
        openDeps: NO_OPEN_DEPS,
        records,
        ...bookkeeping,
        serialize: async (_sessionId, task) => task(),
        hasSession: () => false,
        onReadable: () => undefined
      })

    /** A failure that takes a while, as a lock wait does, so the chats open at once overlap it. */
    const slowFailure = async (): Promise<boolean> => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return false
    }

    beforeEach(() => restoreRead.mockResolvedValue(null))

    it('skips it for every chat when the pass check fails, and still opens them all', async () => {
      const reconcile = vi.fn(slowFailure)
      const resolveRecovery = vi.fn(async () => true)

      await restore({ reconcile, resolveRecovery })

      expect(reconcile).toHaveBeenCalledOnce()
      expect(resolveRecovery).not.toHaveBeenCalled()
      expect(restoreRead).toHaveBeenCalledTimes(records.length)
    })

    it('starts no more after the first failed recovery, and still opens every chat', async () => {
      const resolveRecovery = vi.fn(slowFailure)

      await restore({ reconcile: async () => true, resolveRecovery })

      // Only those already started when the first failed: at most one per chat open at once.
      expect(resolveRecovery.mock.calls.length).toBeLessThanOrEqual(4)
      expect(restoreRead).toHaveBeenCalledTimes(records.length)
    })
  })

  it('opens every other chat when one chat cannot be opened, and the pass still settles', async () => {
    restoreRead.mockImplementation(async (_deps, sessionId: string) => {
      if (sessionId === 'session-0') {
        throw new Error('this chat cannot be opened')
      }
      return { session: { journal: {}, params: {}, child: null, sessionId } }
    })
    const readable: string[] = []
    const log = recordingStructuredAgentSessionLogger()
    const records = Array.from(
      { length: 12 },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    await expect(
      restoreStructuredAgentSessionsOnRestart({
        openDeps: { ...NO_OPEN_DEPS, logger: log.logger },
        records,
        reconcile: async () => true,
        resolveRecovery: async () => true,
        serialize: async (_sessionId, task) => task(),
        hasSession: () => false,
        onReadable: (sessionId) => {
          readable.push(sessionId)
        }
      })
    ).resolves.toBeUndefined()

    expect(readable).toEqual(records.slice(1).map((record) => record.sessionId))
    expect(log.entries).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ scope: 'restart-restore', sessionId: 'session-0' })
      })
    ])
  })

  it('does not settle again when a second restore finds the session already open', async () => {
    restoreRead.mockResolvedValue({
      session: { journal: {}, params: {}, child: null }
    })

    await restoreStructuredAgentSessionsOnRestart({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      records: [{ sessionId: 'session-1' } as AgentSessionRecord],
      openDeps: NO_OPEN_DEPS,
      reconcile: async () => true,
      resolveRecovery: async () => true,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => true,
      onReadable: () => undefined
    })

    // The open is where the settlement runs, and a session already open is not opened again.
    expect(restoreRead).not.toHaveBeenCalled()
  })
})
