import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

const { restoreRead } = vi.hoisted(() => ({
  restoreRead: vi.fn()
}))

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: restoreRead
}))

import {
  restoreOneStructuredAgentSessionRead,
  restoreStructuredAgentSessionsOnRestart
} from './structured-agent-session-restart-restore'

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
      settleStaleState: async () => undefined
    })

    await vi.waitFor(() => expect(active).toBe(4))
    expect(restoreRead).toHaveBeenCalledTimes(4)
    gate.resolve()
    await restoration

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    expect(peak).toBe(4)
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
    // Compared by identity only; the restore passes it through untouched.
    const restored: unknown = {
      session: {
        journal: {},
        params,
        fence: 4,
        child: null,
        acquisitionGeneration: null
      },
      reset: null
    }
    restoreRead.mockResolvedValue(restored)

    await restoreOneStructuredAgentSessionRead(
      {
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
        settleStaleState: async (_sessionId, settled) => {
          calls.push(settled === restored ? 'settleStaleState:restored' : 'settleStaleState')
        }
      },
      'session-1'
    )

    expect(calls).toEqual(['resolveRecovery', 'settleStaleState:restored', 'onReadable'])
  })

  it('does not settle again when a second restore finds the session already open', async () => {
    const settleStaleState = vi.fn(async () => undefined)
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

    await restoreOneStructuredAgentSessionRead(
      {
        openDeps: NO_OPEN_DEPS,
        reconcile: async () => null,
        resolveRecovery: async () => undefined,
        serialize: async (_sessionId, task) => task(),
        hasSession: () => true,
        onReadable: () => undefined,
        settleStaleState
      },
      'session-1'
    )

    expect(settleStaleState).not.toHaveBeenCalled()
  })
})
