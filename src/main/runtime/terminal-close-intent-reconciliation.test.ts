import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyStopReceipt } from '../../shared/pty-stop-receipt'
import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { withTerminalCloseAttribution } from './rpc/terminal-close-attribution'
import { reconcileTerminalCloseIntent } from './terminal-close-intent-reconciliation'

const identity = {
  executionHostId: 'local',
  workspaceKey: 'folder:workspace-1',
  terminalHandle: 'term-1',
  ptyIncarnation: 'pty-1:inc-1',
  processRootId: 'pty-1'
}

describe('terminal close intent reconciliation', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      getOrchestrationDb: () => db,
      showTerminal: vi.fn(async () => ({
        ptyId: identity.processRootId,
        executionHostId: identity.executionHostId,
        worktreeId: identity.workspaceKey
      })),
      getTerminalProcessIncarnation: vi.fn(() => identity.ptyIncarnation)
    } as unknown as OrcaRuntimeService
    const intent = db.reserveTerminalCloseIntent({
      mutationId: 'close-1',
      ...identity,
      targetKind: 'terminal',
      ownerPrincipal: 'device-1',
      reason: 'user-close'
    })
    return { runtime, intent }
  }

  function result(verdict: 'exited' | 'unverifiable' | 'capability_limited'): RuntimeTerminalClose {
    const root =
      verdict === 'exited'
        ? { pid: 41, parentPid: 1, processGroupId: 41, startedAt: 'captured' }
        : { pid: null, parentPid: null, processGroupId: null, startedAt: null }
    const receipt = createPtyStopReceipt({
      executionHostId: 'local',
      terminalHandle: identity.terminalHandle,
      ptyId: identity.processRootId,
      ptyIncarnation: identity.ptyIncarnation,
      root,
      descendants: [],
      observations: [
        {
          identity: root,
          status: verdict === 'exited' ? 'absent' : 'unverifiable',
          observedAt: '2026-08-24T12:00:00.000Z'
        }
      ],
      verdict,
      processTreeVerified: verdict === 'exited',
      reason: verdict === 'exited' ? undefined : 'host_capability_unavailable'
    })
    return {
      handle: identity.terminalHandle,
      tabId: 'tab-1',
      ptyKilled: verdict === 'exited',
      ptyStopReceipt: receipt
    }
  }

  it('persists and replays the exact verified receipt without closing twice', async () => {
    const { runtime, intent } = setup()
    const close = vi.fn(async () => result('exited'))
    const first = await reconcileTerminalCloseIntent({ runtime, intent, close })
    const settled = db?.getTerminalCloseIntent(intent.mutationId)
    const replay = await reconcileTerminalCloseIntent({ runtime, intent: settled!, close })

    expect(replay).toEqual(first)
    expect(close).toHaveBeenCalledTimes(1)
    expect(settled).toMatchObject({ state: 'released', autoRelease: true })
  })

  it('replays a persisted receipt by request id after the terminal disappears', async () => {
    const { runtime, intent } = setup()
    const settledResult = result('exited')
    db?.updateTerminalCloseIntent(intent.mutationId, {
      state: 'released',
      result: settledResult,
      autoRelease: true
    })
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_not_found'))
    const close = vi.fn()

    const replay = await withTerminalCloseAttribution(
      'terminal.close',
      { runtime, requestId: intent.mutationId, pairedDeviceId: 'device-1' },
      'terminal',
      identity.terminalHandle,
      close
    )

    expect(replay).toEqual(settledResult)
    expect(runtime.showTerminal).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it.each(['reserved', 'closing', 'outcome_unknown'] as const)(
    'revisits a %s intent through exact request replay',
    async (state) => {
      const { runtime, intent } = setup()
      if (state !== 'reserved') {
        db?.updateTerminalCloseIntent(intent.mutationId, { state })
      }
      const close = vi.fn(async () => result('exited'))

      await withTerminalCloseAttribution(
        'terminal.close',
        { runtime, requestId: intent.mutationId, pairedDeviceId: 'device-1' },
        'terminal',
        identity.terminalHandle,
        close
      )

      expect(close).toHaveBeenCalledOnce()
      expect(db?.getTerminalCloseIntent(intent.mutationId)).toMatchObject({ state: 'released' })
    }
  )

  it('fails closed when the terminal handle was reminted', async () => {
    const { runtime, intent } = setup()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('pty-2:inc-2')
    const close = vi.fn()

    await expect(reconcileTerminalCloseIntent({ runtime, intent, close })).rejects.toMatchObject({
      code: 'terminal_close_outcome_unknown'
    })
    expect(close).not.toHaveBeenCalled()
    expect(db?.getTerminalCloseIntent(intent.mutationId)).toMatchObject({
      state: 'outcome_unknown',
      autoRelease: false
    })
  })

  it('keeps capability-limited hosts out of auto release', async () => {
    const { runtime, intent } = setup()
    await reconcileTerminalCloseIntent({
      runtime,
      intent,
      close: async () => result('capability_limited')
    })

    expect(db?.getTerminalCloseIntent(intent.mutationId)).toMatchObject({
      state: 'capability_limited',
      autoRelease: false
    })
  })

  it('does not treat a receipt-free SSH disconnect as process death', async () => {
    const { runtime, intent } = setup()
    await reconcileTerminalCloseIntent({
      runtime,
      intent,
      close: async () => ({
        handle: identity.terminalHandle,
        tabId: 'tab-1',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'ssh_disconnected'
      })
    })

    expect(db?.getTerminalCloseIntent(intent.mutationId)).toMatchObject({
      state: 'outcome_unknown',
      autoRelease: false,
      lastError: 'pty_stop_receipt_missing'
    })
  })
})
