/**
 * What the headless automation sweep asks a runtime about a run's terminal before closing it:
 * whether a client used it, and whether only its shell still runs.
 */
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { TerminalRunFactsRegister } from './terminal-run-facts'
import {
  confirmRootShellAloneFromProcessTable,
  inspectionShowsShellAlone
} from './run-terminal-shell-alone'

/**
 * Whether a client drove or is viewing a PTY's current process, for closing finished run
 * terminals: `unknown` when this process cannot tell (it adopted the PTY rather than spawned it).
 */
export function readRunTerminalClientUse(
  host: {
    hasRawTerminalViewSubscriber: (ptyId: string) => boolean
    terminalRunFacts: Pick<TerminalRunFactsRegister, 'read'>
  },
  ptyId: string
): 'used' | 'unused' | 'unknown' {
  if (host.hasRawTerminalViewSubscriber(ptyId)) {
    return 'used'
  }
  const facts = host.terminalRunFacts.read(ptyId, undefined)
  if (facts.firstUserInputAt !== null) {
    return 'used'
  }
  return facts.freshSpawn ? 'unused' : 'unknown'
}

/**
 * Fresh execution-host proof that only the spawned shell runs in a PTY, at its prompt, on POSIX
 * and Windows alike; false whenever that cannot be proven.
 */
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
    const processes = (await controller?.listProcesses?.(null)) ?? []
    const rootPid = processes.find((entry) => entry.id === ptyId)?.rootProcessId
    return rootPid ? await confirmRootShellAloneFromProcessTable(rootPid) : false
  } catch {
    return false
  }
}
