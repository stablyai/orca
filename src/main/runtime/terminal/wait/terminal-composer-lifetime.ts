import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'
import type { RuntimeTerminalWait } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { holdTerminalInputCustody } from './terminal-input-custody'

export async function waitForTerminalComposer(
  {
    handle,
    getTarget,
    buildResult,
    waiters,
    signal
  }: {
    handle: string
    getTarget: () => RuntimePtyWorktreeRecord
    buildResult: () => RuntimeTerminalWait
    waiters: RuntimeTerminalWaiterRegistry
    signal?: AbortSignal
  },
  observe: (target: RuntimePtyWorktreeRecord, stop: AbortController) => Promise<string | null>
): Promise<RuntimeTerminalWait> {
  return holdTerminalInputCustody(
    { handle, target: getTarget(), readTarget: getTarget, waiters, signal },
    async ({ target, stop, assertLive, assertOriginal }) => {
      const ptyId = await observe(target, stop)
      if (!ptyId) {
        assertLive()
        throw new Error(stop.signal.aborted ? 'agent_startup_dialog' : 'timeout')
      }
      assertOriginal()
      return buildResult()
    }
  )
}
