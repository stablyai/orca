import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

const { restoreOnRestart } = vi.hoisted(() => ({ restoreOnRestart: vi.fn() }))

vi.mock('./structured-agent-session-restart-restore', () => ({
  restoreStructuredAgentSessionsOnRestart: restoreOnRestart
}))

import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'

describe('StructuredAgentSessionReadableRestorer', () => {
  beforeEach(() => {
    restoreOnRestart.mockReset().mockResolvedValue(undefined)
  })

  it('passes targeted records to the restore pool in visible-first order', async () => {
    const records = ['background-a', 'visible-b', 'visible-a', 'background-b'].map(
      (sessionId) => ({ sessionId }) as AgentSessionRecord
    )
    const restorer = new StructuredAgentSessionReadableRestorer({
      store: { listRecords: () => records } as never,
      journalRoot: '/tmp/journals',
      supportsRecord: () => true,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined,
      restoreHandoff: async () => undefined
    })

    await restorer.restore(['visible-a', 'visible-b', 'background-a', 'background-b'])

    expect(restoreOnRestart).toHaveBeenCalledOnce()
    expect(restoreOnRestart.mock.calls[0][0].records.map((record) => record.sessionId)).toEqual([
      'visible-a',
      'visible-b',
      'background-a',
      'background-b'
    ])
  })
})
