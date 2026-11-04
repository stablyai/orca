/** Deliver text the startup command cannot carry: stdin prompts, long/multiline text and reused terminals.
 * Reuse worker readiness and sendTerminalAgentPrompt for serialized, generation-fenced bracketed paste and per-agent Enter timing across local, WSL and SSH. */

import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import { deliverGeneratedTerminalInput } from '../../terminal/input/generated-terminal-input-delivery'
import type { GeneratedInputOutcome } from '../../../../shared/generated-terminal-input'
import {
  waitForLaunchedAgentComposer,
  type TerminalReadinessCreation,
  type LaunchedAgentReadinessRuntime
} from '../../launched-agent-composer-readiness'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { assertAgentPromptRequestActive } from '../../orca-runtime-core'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime,
  type UnprovableHostPolicy
} from '../../launched-agent-write-guard'

/** The same budget orchestration gives a worker to reach its composer before dispatching to it. */
const AGENT_READY_TIMEOUT_MS = 60_000
/** How often a launch re-checks a blocking prompt the user may still dismiss. */
const BLOCKED_RECHECK_MS = 1_000

export type TerminalPromptRuntime = LaunchedAgentReadinessRuntime &
  LaunchedAgentWriteGuardRuntime &
  Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>

type ReadinessClock = { now: () => number; sleep: (ms: number) => Promise<void> }

const REAL_CLOCK: ReadinessClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait through user-dismissable trust/update prompts within one budget; never paste while a dialog remains. */
async function waitThroughBlockingPrompts(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  freshLaunch: boolean,
  clock: ReadinessClock,
  signal: AbortSignal | undefined,
  terminalCreation?: TerminalReadinessCreation
): Promise<RuntimeTerminalWait | undefined> {
  const deadline = clock.now() + AGENT_READY_TIMEOUT_MS
  for (;;) {
    // At least 1 ms: the terminal wait reads 0 as "use the 5-minute default", and a late sleep can
    // land past the deadline.
    const timeoutMs = Math.max(1, deadline - clock.now())
    const wait = freshLaunch
      ? await waitForLaunchedAgentComposer(
          runtime,
          handle,
          agent,
          timeoutMs,
          signal,
          terminalCreation
        )
      : // A reused pane was not freshly launched: its composer marker may be long gone.
        await runtime.waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs,
          ...(signal ? { signal } : {})
        })
    if (!wait?.blockedReason || wait.satisfied || deadline - clock.now() <= BLOCKED_RECHECK_MS) {
      return wait
    }
    await clock.sleep(BLOCKED_RECHECK_MS)
    assertAgentPromptRequestActive(signal)
  }
}

/** A freshly started agent's readiness, as a launch prompt waits for it, blocking prompts included. */
export function waitForStartedAgentReady(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  signal?: AbortSignal,
  terminalCreation?: TerminalReadinessCreation
): Promise<RuntimeTerminalWait | undefined> {
  return waitThroughBlockingPrompts(
    runtime,
    handle,
    agent,
    true,
    REAL_CLOCK,
    signal,
    terminalCreation
  )
}

/** Report whether text reached the pane without failing an already-running launch.
 * The launch's readiness wait is an observation; the host's one generated-input transaction decides. */
export async function deliverTerminalAgentLaunchPrompt(args: {
  runtime: TerminalPromptRuntime
  handle: string
  agent: TuiAgent
  /** False for a reused terminal, whose agent was already running before this launch. */
  freshLaunch: boolean
  terminalCreation?: TerminalReadinessCreation
  text: string
  /** See `createLaunchedAgentWriteGuard`; default `refuse`. */
  unprovableHost?: UnprovableHostPolicy
  clock?: ReadinessClock
  /** Aborting ends the readiness wait and refuses the paste; text already handed over stays so. */
  signal?: AbortSignal
  /** Not delivered: proven not written, or possibly written in part. */
  onRefused?: (certainty: 'not-sent' | 'unconfirmed') => void
  /** The host's typed outcome, for callers that may only fall back when the target was gone. */
  onOutcome?: (outcome: GeneratedInputOutcome) => void
}): Promise<boolean> {
  if (args.text.trim().length === 0) {
    return false
  }
  // Check before paste and Enter: a ready signal may belong to a shell after the agent exits.
  const guard = createLaunchedAgentWriteGuard(args.runtime, args.agent, {
    unprovableHost: args.unprovableHost
  })
  const clock = args.clock ?? REAL_CLOCK
  const deadline = clock.now() + AGENT_READY_TIMEOUT_MS
  try {
    const wait = await waitThroughBlockingPrompts(
      args.runtime,
      args.handle,
      args.agent,
      args.freshLaunch,
      clock,
      args.signal,
      args.terminalCreation
    )
    // A dialog the wait still saw at its end is a veto; anything else is the host's to decide.
    if (wait?.blockedReason && !wait.satisfied) {
      console.warn(
        `[agent-launch] a dialog still held the terminal (${wait.blockedReason}); its launch prompt was not delivered`
      )
      args.onOutcome?.('not-sent')
      args.onRefused?.('not-sent')
      return false
    }
    const outcome = await deliverGeneratedTerminalInput(args.runtime, args.handle, {
      text: args.text,
      submit: true,
      agent: args.agent,
      timeoutMs: Math.max(0, deadline - clock.now()),
      // A fresh launch must prove its composer; a reused agent is already reading input.
      intent: args.freshLaunch ? 'startup' : 'running',
      observedReady: wait?.satisfied === true,
      // A fresh launch's composer was just seen ready; a reused pane's state is only inferred.
      composerReady: args.freshLaunch,
      beforeWrite: guard.beforeWrite,
      ...(args.signal ? { signal: args.signal } : {})
    })
    args.onOutcome?.(outcome)
    if (outcome === 'delivered') {
      return true
    }
    console.warn(
      `[agent-launch] the terminal agent started, its launch prompt was not delivered (${outcome})`
    )
    args.onRefused?.(outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent')
    return false
  } catch (error) {
    // Only the readiness wait throws here (a start failure or abort); nothing was written.
    args.onRefused?.('not-sent')
    console.warn(
      '[agent-launch] the terminal agent started, its launch prompt was not delivered',
      error
    )
    return false
  } finally {
    guard.dispose()
  }
}
