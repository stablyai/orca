import {
  createSetupWaitGate,
  SETUP_WAIT_GATE_MAX_MS
} from '../../../../shared/agent-launch/startup/setup-wait-output-gate'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'

export function waitForWorktreeSetupGate(
  host: WorktreeStartupReadinessHost,
  ptyId: string,
  signal: AbortSignal,
  onOutcome?: (outcome: 'started' | 'blocked' | 'failed' | 'unknown') => void
): Promise<boolean | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    const gate = createSetupWaitGate(true)
    let unsubscribe: (() => void) | undefined
    let finished = false
    const finish = (outcome: 'started' | 'blocked' | 'failed' | 'unknown'): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      unsubscribe?.()
      signal.removeEventListener('abort', abort)
      resolve(outcome === 'unknown' ? undefined : outcome === 'started')
      onOutcome?.(outcome)
    }
    const abort = (): void => finish('unknown')
    const timer = setTimeout(abort, SETUP_WAIT_GATE_MAX_MS)
    timer.unref()
    const observe = (data: string): void => {
      const { phase, blocked } = gate.observe(data)
      if (phase === 'started' || phase === 'failed') {
        finish(blocked ? 'blocked' : phase)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    unsubscribe = host.subscribeToData(ptyId, observe)
    if (finished) {
      unsubscribe()
    } else {
      observe(host.readRecentOutput(ptyId) ?? '')
    }
  })
}

export function generatedSetupStartupCommand(
  opts: TerminalCreateOptions,
  connectionId: string | null | undefined
): string | undefined {
  return !connectionId && opts.launchConfig?.commandProvenance === 'generated'
    ? opts.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    : undefined
}
