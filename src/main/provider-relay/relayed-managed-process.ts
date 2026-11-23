import type {
  ManagedProviderProcess,
  ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import type { ProviderRelayFailure } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { RelayedProviderChild } from './relayed-provider-child'

/** Past the daemon's own stdin-end, SIGTERM and SIGKILL ladder. */
const RELAY_CLOSE_WAIT_MS = 15_000

const RELAY_FAILURE_WORDS: Record<ProviderRelayFailure, string> = {
  'line-too-large':
    'The agent sent a message too large to relay (over 256 MiB), so Orca stopped it.',
  'line-unreadable': "Orca couldn't read the agent's output, so it stopped the agent.",
  'line-undeliverable': "Orca couldn't keep the agent's output, so it stopped the agent.",
  'spool-unreadable': "Orca lost the agent's saved output, so it stopped the agent."
}

/** Visible words for why the terminal host ended a chat's agent itself; null for an ordinary exit. */
export function providerRelayFailureWords(error: ProviderRelayFailure | undefined): string | null {
  return error ? RELAY_FAILURE_WORDS[error] : null
}

/**
 * The managed-process surface over a relayed agent. The daemon runs the close ladder and the group
 * reap, so a close here is a request to it; exit proof is the daemon's `relayExit`.
 */
export function relayedManagedProcess(child: RelayedProviderChild): ManagedProviderProcess {
  let observed: ProviderProcessExit | null = null
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  const exited = Promise.withResolvers<void>()
  const observe = (): void => {
    if (observed) {
      return
    }
    observed = {
      code: child.exitCode,
      signal: child.signalCode,
      processless: false,
      ...(child.outcomeLost ? { outcomeLost: true as const } : {})
    }
    exited.resolve()
    for (const listener of listeners) {
      listener(observed)
    }
    listeners.clear()
  }
  child.once('exit', observe)

  const stderrTail = (): string => {
    const exit = child.exited
    const words = providerRelayFailureWords(exit?.error)
    const tail = exit?.stderrTail ?? child.attachResult?.stderrTail ?? ''
    // First, so a reader that keeps only the start of the tail still says why.
    return words ? `${words}\n${tail}` : tail
  }

  const close = async (): Promise<ProviderProcessCloseResult> => {
    if (child.handedOff) {
      // Detached on quit: the agent is the daemon's now, and nothing of it is this app's to wait on.
      lastCloseResult = { root: 'exited', tree: 'exited' }
      return lastCloseResult
    }
    if (!observed) {
      await child.close()
      // The daemon's close ladder is bounded; a host that stops answering proves nothing.
      const timer = Promise.withResolvers<void>()
      const timeout = setTimeout(timer.resolve, RELAY_CLOSE_WAIT_MS)
      await Promise.race([exited.promise, timer.promise])
      clearTimeout(timeout)
    }
    lastCloseResult = observed ? { root: 'exited', tree: 'exited' } : { root: 'live', tree: null }
    return lastCloseResult
  }

  return {
    child,
    supervised: true,
    exitPromise: exited.promise,
    get exitStatus() {
      return observed
    },
    processless: false,
    get rootVerdict() {
      return observed || child.handedOff ? 'exited' : 'live'
    },
    get rootExitObserved() {
      return observed !== null && !observed.outcomeLost
    },
    executableMissing: false,
    spawnAbsence: null,
    stderrTail,
    get lastCloseResult() {
      return lastCloseResult
    },
    onExit(listener) {
      if (observed) {
        listener(observed)
      } else {
        listeners.add(listener)
      }
    },
    terminateTree: async () => {
      await close()
      return 'exited'
    },
    close: () => close(),
    closeWriter: () => close()
  }
}
