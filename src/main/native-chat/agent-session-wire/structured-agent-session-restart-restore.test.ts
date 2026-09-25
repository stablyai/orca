import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

const { restoreRead } = vi.hoisted(() => ({
  restoreRead: vi.fn()
}))

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: restoreRead
}))

import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

const NO_OPEN_DEPS = {
  store: { getRecord: () => null, listRecords: () => [] },
  journalRoot: '/tmp/journals',
  adapter: {}
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
        },
        reset: null
      }
    })
    const records = Array.from(
      { length: 12 },
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    const restoration = restoreStructuredAgentSessionsOnRestart({
      openDeps: NO_OPEN_DEPS,
      records,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined,
      retrySettlement: async () => true
    })

    await vi.waitFor(() => expect(active).toBe(4))
    expect(restoreRead).toHaveBeenCalledTimes(4)
    gate.resolve()
    await restoration

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    expect(peak).toBe(4)
  })

  it('runs pending settlement retry after recovery resolution', async () => {
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
    restoreRead.mockResolvedValue({
      session: {
        journal: {},
        params,
        fence: 4,
        child: null,
        acquisitionGeneration: null
      },
      reset: null
    })

    await restoreStructuredAgentSessionsOnRestart({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      records: [{ sessionId: 'session-1' } as AgentSessionRecord],
      openDeps: NO_OPEN_DEPS,
      reconcile: async () => null,
      resolveRecovery: async () => {
        calls.push('resolveRecovery')
      },
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => {
        calls.push('onReadable')
      },
      retrySettlement: async (_sessionId, restoredParams) => {
        calls.push(
          restoredParams === params ? 'retrySettlement:restored-params' : 'retrySettlement'
        )
        return true
      }
    })

    expect(calls).toEqual(['resolveRecovery', 'onReadable', 'retrySettlement:restored-params'])
  })

  it('does not rerun settlement retry when a second restore finds the session already open', async () => {
    const retrySettlement = vi.fn(async () => true)
    restoreRead.mockResolvedValue({
      session: {
        journal: {},
        params: {},
        fence: 4,
        child: null,
        acquisitionGeneration: null
      },
      reset: null
    })

    await restoreStructuredAgentSessionsOnRestart({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the record's session id here.
      records: [{ sessionId: 'session-1' } as AgentSessionRecord],
      openDeps: NO_OPEN_DEPS,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => true,
      onReadable: () => undefined,
      retrySettlement
    })

    expect(retrySettlement).not.toHaveBeenCalled()
  })
})
