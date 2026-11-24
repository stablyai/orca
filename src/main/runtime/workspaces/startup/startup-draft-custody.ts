import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import type { RuntimeTerminalWaiterRegistry } from '../../terminal/wait/terminal-waiter-registry'
import { holdTerminalInputCustody } from '../../terminal/wait/terminal-input-custody'
import type { WorktreeStartupDraftPaste } from './runtime-worktree-agent-startup'
import {
  waitForWorktreeStartupDraft,
  type StartupPromptDeliveryGuard,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

export type StartupDraftCustodyHost = {
  readiness: WorktreeStartupReadinessHost
  waiters: RuntimeTerminalWaiterRegistry
  readPty: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
  lifecycleSignal: (ptyId: string) => AbortSignal
  isStopRequested: (ptyId: string) => boolean
}

/** The draft belongs to the process its handle named at capture: closing the window keeps it, a replacement never gets it. */
export function pasteStartupDraftInCustody(
  host: StartupDraftCustodyHost,
  handle: string,
  draft: WorktreeStartupDraftPaste,
  guard: StartupPromptDeliveryGuard = {}
): void {
  const ptyId = host.readiness.getPtyId(handle)
  const target = ptyId ? host.readPty(ptyId) : undefined
  if (!target) {
    console.warn('[worktree-create] agent did not become ready for draft paste')
    return
  }
  void holdTerminalInputCustody(
    {
      handle,
      target,
      readTarget: () => host.readPty(target.ptyId),
      waiters: host.waiters,
      signal: host.lifecycleSignal(target.ptyId),
      outlivesRenderer: true
    },
    async ({ stop, assertLive, assertOriginal }) => {
      const readyPtyId = await waitForWorktreeStartupDraft(
        { ...host.readiness, getPtyId: () => target.ptyId },
        handle,
        draft.agent,
        {
          signal: guard.signal ? AbortSignal.any([stop.signal, guard.signal]) : stop.signal,
          afterSetup: true
        }
      )
      if (!readyPtyId) {
        assertLive()
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      assertOriginal()
      if (host.isStopRequested(target.ptyId)) {
        throw new Error('terminal_not_writable')
      }
      // The agent took time to be ready; its caller is approved again right before the paste.
      guard.beforeWrite?.()
      host.readiness.write(target.ptyId, `\x1b[200~${draft.content}\x1b[201~`, 'launch')
    }
  ).catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}
