/** Deliver text the startup command cannot carry: stdin prompts, long/multiline text and reused terminals.
 * Reuse worker readiness and sendTerminalAgentPrompt for serialized, generation-fenced bracketed paste and per-agent Enter timing across local, WSL and SSH. */

import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
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
 * A stalled post-write verification still means delivered; reporting not-delivered invites a duplicate turn. */
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
}): Promise<boolean> {
  if (args.text.trim().length === 0) {
    return false
  }
  // Check before paste and Enter: a ready signal may belong to a shell after the agent exits.
  const guard = createLaunchedAgentWriteGuard(args.runtime, args.agent, {
    unprovableHost: args.unprovableHost
  })
  // Once Enter left, a later throw (an abort during verification) cannot unsend the text.
  let submitted = false
  try {
    const wait = await waitThroughBlockingPrompts(
      args.runtime,
      args.handle,
      args.agent,
      args.freshLaunch,
      args.clock ?? REAL_CLOCK,
      args.signal,
      args.terminalCreation
    )
    // An unsatisfied wait does not authorize pasting into a dialog, dead process or unready agent.
    if (wait && !wait.satisfied) {
      console.warn(
        `[agent-launch] the terminal agent did not become ready (${wait.status}); its launch prompt was not delivered`
      )
      return false
    }
    const sent = await args.runtime.sendTerminalAgentPrompt(args.handle, args.text, {
      inputKind: 'launch',
      // A fresh launch's composer was just seen ready; a reused pane's state is only inferred.
      composerReady: args.freshLaunch,
      beforeWrite: guard.beforeWrite,
      // Both fields enable queued acceptance; without requestId a slow first turn throws despite written input.
      acceptQueued: true,
      requestId: randomUUID(),
      // Once handed over, let the pane show progress; the launch receipt does not claim turn observation.
      observationTimeoutMs: 0,
      ...(args.signal
        ? {
            signal: args.signal,
            onSubmitWritten: () => {
              submitted = true
            }
          }
        : {})
    })
    return sent.accepted
  } catch (error) {
    if (isAgentPromptStalledError(error) || submitted) {
      return true
    }
    console.warn(
      '[agent-launch] the terminal agent started, its launch prompt was not delivered',
      error
    )
    return false
  } finally {
    guard.dispose()
  }
}
