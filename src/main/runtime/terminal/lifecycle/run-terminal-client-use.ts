import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { TerminalRunFactsRegister } from './terminal-run-facts'
import {
  confirmRootShellAloneFromProcessTable,
  inspectionShowsShellAlone
} from './run-terminal-shell-alone'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'

/** For finished-run cleanup, adopted PTYs have unknown client-use history because this process did not spawn them. */
export function readRunTerminalClientUse(
  host: {
    hasRawTerminalViewSubscriber: (ptyId: string) => boolean
    terminalRunFacts: Pick<TerminalRunFactsRegister, 'read' | 'wasOpenedByUser'>
  },
  ptyId: string
): 'used' | 'unused' | 'unknown' {
  if (host.hasRawTerminalViewSubscriber(ptyId)) {
    return 'used'
  }
  const facts = host.terminalRunFacts.read(ptyId, undefined)
  if (facts.firstUserInputAt !== null || host.terminalRunFacts.wasOpenedByUser(ptyId)) {
    return 'used'
  }
  return facts.freshSpawn ? 'unused' : 'unknown'
}

/** Mark the pane a user open shows, read after any spawn it started so a new process keeps the mark. */
export function recordShownTerminalUserOpen(
  host: {
    mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
    terminalRunFacts: Pick<TerminalRunFactsRegister, 'recordUserOpen'>
  },
  worktreeId: string,
  tabId: string
): void {
  const shown = host.mobileSessionTabsByWorktree
    .get(worktreeId)
    ?.tabs.find((tab) => tab.id === tabId)
  if (shown?.type === 'terminal' && shown.ptyId) {
    host.terminalRunFacts.recordUserOpen(shown.ptyId)
  }
}

/** Require fresh execution-host proof that only the shell runs at its prompt, on POSIX and Windows; observation failure is unproven. */
export async function confirmRunTerminalShellAlone(
  controller: RuntimePtyController | null | undefined,
  ptyId: string
): Promise<boolean> {
  try {
    if (await controller?.confirmShellForeground?.(ptyId)) {
      return true
    }
    if (process.platform === 'win32') {
      return inspectionShowsShellAlone(
        (await controller?.inspectProcess?.(ptyId, { scanChildProcesses: true })) ?? null
      )
    }
    const processes = (await controller?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)) ?? []
    const rootPid = processes.find((entry) => entry.id === ptyId)?.rootProcessId
    return rootPid ? await confirmRootShellAloneFromProcessTable(rootPid) : false
  } catch {
    return false
  }
}
