import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalWaitBlockedReason
} from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import type { LaunchTurnStartVerdict } from '../../../../launch-turn-start-observation'

/**
 * Turn-start verdict for a dispatched worker prompt, in the execution-boundary vocabulary:
 *
 * - 'observed': the provider proved a turn started for this request. Positive liveness.
 * - 'permission': the agent rendered an approval prompt after the write. Positive liveness,
 *   but the turn is blocked on a human.
 * - 'unsupported': this provider exposes no turn-start signal; the accepted write is the
 *   strongest receipt that can exist. Never treated as failure.
 * - 'unobserved': observation IS supported and no turn started within the window. This is
 *   `unverifiable`, never evidence of death — the bytes were written, but the agent may be
 *   wedged at startup or holding the spec unsent in its composer.
 */
export type WorkerTurnStartVerdict = 'observed' | 'permission' | 'unsupported' | 'unobserved'

export type WorkerTurnStartObservation = {
  verdict: WorkerTurnStartVerdict
  prompt?: RuntimeTerminalPromptDelivery
  /** Why an `unobserved` start is unknown, when the default PTY wording does not fit. */
  reason?: string
  /** A startup dialog held a launched agent; the brief it was launched with runs once answered. */
  blockedReason?: RuntimeTerminalWaitBlockedReason
}

function classifyPromptDelivery(prompt: RuntimeTerminalPromptDelivery): WorkerTurnStartVerdict {
  if (prompt.stages.includes('turn_started')) {
    return 'observed'
  }
  if (prompt.observation === 'permission') {
    return 'permission'
  }
  if (prompt.observation === 'supported') {
    return 'unobserved'
  }
  // 'unsupported' (and an old host's missing observation) leaves acceptance as the best receipt.
  return 'unsupported'
}

/**
 * Second-stage turn-start observation for a worker prompt that was accepted without waiting on
 * provider hooks. Reuses the same observer that terminal.send receipts replay through, so the
 * evidence rules (lifecycle edge or hook turn-start, never output bytes) stay in one place.
 *
 * The observation window is `AGENT_PROMPT_EFFECT_TIMEOUT_MS`, which worker-start's client RPC
 * grace already budgets for (see orchestration-worker-start-prompt-budget.ts).
 */
export async function observeWorkerTurnStart(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  prompt: RuntimeTerminalPromptDelivery | undefined
  timeoutMs?: number
}): Promise<WorkerTurnStartObservation> {
  if (!args.prompt) {
    return { verdict: 'unsupported' }
  }
  const verdict = classifyPromptDelivery(args.prompt)
  if (verdict !== 'unobserved') {
    return { verdict, prompt: args.prompt }
  }
  let observed: RuntimeTerminalPromptDelivery
  try {
    observed = await args.runtime.observeTerminalAgentPrompt(
      args.terminalHandle,
      args.prompt,
      args.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS
    )
  } catch {
    // Observation failure cannot revoke authority for input that was already accepted.
    return { verdict: 'unobserved', prompt: args.prompt }
  }
  if (observed.observation === 'incarnation_replaced') {
    // The PTY under this handle changed mid-observation; the accepted write is unproven.
    return { verdict: 'unobserved', prompt: observed }
  }
  return { verdict: classifyPromptDelivery(observed), prompt: observed }
}

export function describeUnobservedWorkerTurnStart(agent: string | null): string {
  const name = agent ?? 'the agent'
  return (
    `Dispatch input was written and submitted, but ${name}'s turn start could not be verified ` +
    `during observation (up to ${Math.round(AGENT_PROMPT_EFFECT_TIMEOUT_MS / 1000)}s). This is unverifiable, not proof the ` +
    'worker is dead: the agent may still be starting, may be wedged (for example waiting on ' +
    'network), or may be holding the task unsent in its composer. If the worker recovers and ' +
    'reports, this Dispatch settles normally.'
  )
}

/** Pause before re-arming a dialog watch that found the agent idle; an idle screen re-reads instantly. */
const STARTUP_DIALOG_REWATCH_MS = 500

/**
 * Turn-start verdict for a worker whose brief rode its launch command line. The agent's hook turn
 * that carried an explicit prompt after the spawn is the proof; where hooks give none, the launch's
 * own evidence (`observeLaunchTurnStart`). A startup dialog that blocks the agent is reported as
 * blocked but not failed: the brief is already on the agent's command line, so the agent runs it
 * once the dialog is answered, and its report then settles the dispatch. An agent the host proves
 * exited at startup fails the start, as a pasted brief's readiness wait did.
 */
export async function observeWorkerLaunchTurnStart(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  agent: TuiAgent | null
  launchStartedAt: number
  timeoutMs: number
}): Promise<WorkerTurnStartObservation> {
  const { runtime, terminalHandle, timeoutMs } = args
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  try {
    const observed = runtime
      .observeTerminalLaunchTurnStart(
        terminalHandle,
        { launchStartedAt: args.launchStartedAt, agent: args.agent },
        timeoutMs,
        controller.signal
      )
      .catch((): LaunchTurnStartVerdict => 'unobserved')
    const dialog = watchForStartupDialog(runtime, terminalHandle, deadline, controller.signal)
    const first = await Promise.race([
      observed.then((verdict) => ({ verdict, blockedReason: null })),
      dialog.then((blockedReason) => ({ verdict: null, blockedReason }))
    ])
    if (first.blockedReason) {
      return blockedLaunchObservation(first.blockedReason)
    }
    const verdict = first.verdict ?? (await observed)
    if (verdict === 'exited') {
      throw new Error('Agent exited before its first turn started; the shell is back in front.')
    }
    // `unsupported` already read no startup dialog on screen, so neither waits for one to settle.
    if (verdict === 'observed' || verdict === 'unsupported') {
      return { verdict }
    }
    // Why: a dialog already on screen outranks any verdict short of an observed turn.
    const blockedReason = await settledOrNull(dialog)
    if (blockedReason) {
      return blockedLaunchObservation(blockedReason)
    }
    return verdict === 'unobserved'
      ? { verdict, reason: describeUnobservedWorkerLaunch(args.agent, timeoutMs) }
      : { verdict }
  } finally {
    controller.abort()
  }
}

/**
 * Resolves the first startup dialog seen before `deadline`, else null. Re-armed after every idle
 * read, so a dialog that paints after the agent first looks ready is still caught.
 */
async function watchForStartupDialog(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  deadline: number,
  signal: AbortSignal
): Promise<RuntimeTerminalWaitBlockedReason | null> {
  while (!signal.aborted && Date.now() < deadline) {
    const wait = await runtime
      .waitForTerminal(terminalHandle, {
        condition: 'tui-idle',
        launchReadiness: true,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal
      })
      .catch(() => null)
    if (!wait || wait.status === 'exited') {
      return null
    }
    if (wait.blockedReason) {
      return wait.blockedReason
    }
    await abortableDelay(STARTUP_DIALOG_REWATCH_MS, signal)
  }
  return null
}

function blockedLaunchObservation(
  blockedReason: RuntimeTerminalWaitBlockedReason
): WorkerTurnStartObservation {
  return {
    verdict: 'unobserved',
    blockedReason,
    reason:
      `Agent startup blocked: ${describeTerminalWaitBlockedReason(blockedReason)}. The task is ` +
      "already on the agent's command line. If the user answers the dialog in the worker's " +
      'terminal, the agent runs it and its report settles this Dispatch. Otherwise stop the ' +
      'worker with worker-stop, which closes that terminal so the task cannot run later; ' +
      'abandoning would leave it armed there while a retry runs the task again.'
  }
}

function describeUnobservedWorkerLaunch(agent: string | null, windowMs: number): string {
  return (
    `The task rode ${agent ?? 'the agent'}'s launch command line, but its turn start was not ` +
    `observed within ${Math.round(windowMs / 1000)}s. This is unverifiable, not proof the worker ` +
    'is dead: the agent may still be starting or may be wedged (for example waiting on network). ' +
    'If the worker recovers and reports, this Dispatch settles normally.'
  )
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function settledOrNull<T>(promise: Promise<T | null>): Promise<T | null> {
  return await Promise.race([promise, Promise.resolve(null)])
}
