import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

const { restoreRead } = vi.hoisted(() => ({
  restoreRead: vi.fn()
}))

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: restoreRead
}))

import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

describe('restart journal restoration', () => {
  beforeEach(() => restoreRead.mockReset())

  it('bounds historical journal parsing to four sessions at a time', async () => {
    const gate = Promise.withResolvers<void>()
    let active = 0
    let peak = 0
    restoreRead.mockImplementation(async (_store, _root, sessionId: string) => {
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      return {
        journal: {},
        params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' },
        fence: 1,
        hasProviderChild: false,
        sessionId
      }
    })
    const records = Array.from(
      { length: 12 },
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    const restoration = restoreStructuredAgentSessionsOnRestart({
      store: {} as never,
      journalRoot: '/tmp/journals',
      records,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined,
      restoreHandoff: async () => undefined
    })

    await vi.waitFor(() => expect(active).toBe(4))
    expect(restoreRead).toHaveBeenCalledTimes(4)
    gate.resolve()
    await restoration

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    expect(peak).toBe(4)
  })
})
