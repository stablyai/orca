import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const originalPaneKey = process.env.ORCA_PANE_KEY

afterEach(() => {
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
})

describe('orchestration CLI migration recovery', () => {
  it.each([false, true])(
    'accepts an attested legacy worker_done settlement (replayed: %s)',
    async (replayed) => {
      process.env.ORCA_PANE_KEY = 'tab-worker:leaf-worker'
      const call = vi.fn().mockResolvedValue({
        result: {
          message: { id: 'msg_done' },
          lifecycle: { action: 'settled', outcome: 'succeeded', duplicate: replayed }
        }
      })

      await ORCHESTRATION_HANDLERS['orchestration send']({
        flags: new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['subject', 'Done'],
          ['type', 'worker_done']
        ]),
        client: { call },
        cwd: '/tmp/repo',
        json: true
      } as never)

      expect(call).toHaveBeenCalledWith('orchestration.send', {
        from: 'term_worker',
        to: undefined,
        run: undefined,
        subject: 'Done',
        body: undefined,
        type: 'worker_done',
        priority: undefined,
        threadId: undefined,
        payload: undefined,
        senderPaneKey: 'tab-worker:leaf-worker',
        waitForLifecycleSettlement: true,
        devMode: false
      })
      expect(call).toHaveBeenCalledOnce()
    }
  )
})
