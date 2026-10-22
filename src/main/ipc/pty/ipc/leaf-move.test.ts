import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../../agent-hooks/server'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'
import { commitLeafMoveAndRekey } from './leaf-move'

const LEAF = '22222222-2222-4222-8222-222222222222'
const request = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  leafId: LEAF,
  ptyId: 'pty-agent'
}

function deps(result: TerminalLeafMoveResult) {
  const rekeyWorkerTerminalResourcePaneKey = vi.fn(() => 1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this Store method.
  const store = { moveTerminalLeafToNewTab: vi.fn(async () => result) } as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only the orchestration DB accessor.
  const runtime = {
    getExistingOrchestrationDb: () => ({ rekeyWorkerTerminalResourcePaneKey })
  } as unknown as OrcaRuntimeService
  return { store, runtime, rekeyWorkerTerminalResourcePaneKey }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pty:moveLeafToNewTab', () => {
  it('aliases agent status and re-keys worker resources after a committed move', async () => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey } = deps({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    await expect(commitLeafMoveAndRekey({ store, runtime }, request)).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    expect(transfer).toHaveBeenCalledWith(
      `tab-source:${LEAF}`,
      `tab-target:${LEAF}`,
      'pty-agent',
      expect.any(Number),
      { authorityVerified: true }
    )
    expect(rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledWith({
      fromPaneKey: `tab-source:${LEAF}`,
      toPaneKey: `tab-target:${LEAF}`
    })
  })

  it.each<TerminalLeafMoveResult>([
    { status: 'not_held' },
    { status: 'refused', reason: 'pty_mismatch' }
  ])('leaves every pane key alone when the move did not commit (%o)', async (result) => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey } = deps(result)

    await expect(commitLeafMoveAndRekey({ store, runtime }, request)).resolves.toEqual(result)

    expect(transfer).not.toHaveBeenCalled()
    expect(rekeyWorkerTerminalResourcePaneKey).not.toHaveBeenCalled()
  })
})
