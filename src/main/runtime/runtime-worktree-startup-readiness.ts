import { waitForGeneratedAgentInput } from '../../shared/generated-agent-input-readiness'
import { admitsGeneratedInput } from '../../shared/generated-agent-input-admission'
import type { RuledScreen } from '../../shared/screen-input-veto'
import type { TerminalReadinessCreation } from './launched-agent-composer-readiness'
import { isShellProcess } from '../../shared/agent-detection'
import {
  isExpectedAgentProcess,
  isAgentForegroundWrapperProcess
} from '../../shared/agent-process-recognition'
import { resolvePasteReadySignal } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type { GeneratedInputOutcome } from '../../shared/generated-terminal-input'
import type { WorktreeStartupFollowup } from './runtime-worktree-agent-startup'
import {
  deliverTerminalAgentLaunchPrompt,
  type TerminalPromptRuntime
} from './rpc/methods/agent-launch-terminal-prompt'
import { deliverGeneratedTerminalInput } from './terminal/input/generated-terminal-input-delivery'

export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  /** The host's current caught-up screen, null while it cannot be read. */
  readInputScreen?: (ptyId: string) => Promise<RuledScreen | null>
  /** The host model's current bracketed-paste mode, for an observer that missed its byte. */
  bracketedPaste?: (ptyId: string) => boolean
  generation?: (ptyId: string) => number
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

export type StartupFollowupPromptOptions = {
  signal?: AbortSignal
  agentLaunch?: boolean
  terminalCreation?: TerminalReadinessCreation
  /** The prompt was not delivered: proven not written, or possibly written in part. */
  onRefused?: (certainty: 'not-sent' | 'unconfirmed') => void
}

export function generatedInputRefusalCertainty(
  outcome: GeneratedInputOutcome
): 'not-sent' | 'unconfirmed' | null {
  if (outcome === 'delivered' || outcome === 'staged') {
    return null
  }
  return outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
}

/** A post-start agent's first prompt: its process in front can still drop typed text (#10336). */
export async function deliverStartupFollowupPrompt(
  runtime: TerminalPromptRuntime,
  host: WorktreeStartupReadinessHost,
  handle: string,
  { agent, prompt }: WorktreeStartupFollowup,
  options: StartupFollowupPromptOptions = {}
): Promise<boolean> {
  const { signal } = options
  try {
    const ptyId = host.getPtyId(handle)
    // Where no read proves the agent in front (Windows), its process must be seen first: a lone shell's prompt also reads as ready.
    if (ptyId && runtime.launchedAgentHostProvesAgent?.(ptyId) === false) {
      const expected = TUI_AGENT_CONFIG[agent].expectedProcess
      if (!(await waitForWorktreeStartupFollowup(host, handle, expected, signal))) {
        console.warn(
          '[agent-startup] agent did not come to the front; its prompt was not delivered'
        )
        options.onRefused?.('not-sent')
        return false
      }
      // WSL and SSH-to-Windows cannot prove a lone shell either: keep their typed follow-up; agent.launch refused there.
      if (!options.agentLaunch && runtime.launchedAgentHostProvesShellAlone?.(ptyId) !== true) {
        // Typed bytes still go through this PTY's one admitted transaction, Enter rechecked.
        const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
          text: prompt,
          submit: true,
          agent,
          framing: 'typed',
          ...(signal ? { signal } : {})
        })
        const refused = generatedInputRefusalCertainty(outcome)
        if (refused) {
          options.onRefused?.(refused)
        }
        return refused === null
      }
    }
    return await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent,
      freshLaunch: true,
      terminalCreation: options.terminalCreation,
      text: prompt,
      unprovableHost: 'write-if-shell-provable',
      ...(options.onRefused ? { onRefused: options.onRefused } : {}),
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    options.onRefused?.('not-sent')
    console.warn('[agent-startup] failed to deliver the startup prompt:', error)
    return false
  }
}

export async function waitForWorktreeStartupFollowup(
  host: WorktreeStartupReadinessHost,
  handle: string,
  expectedProcess: string,
  signal?: AbortSignal
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return null
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (signal?.aborted) {
      return null
    }
    try {
      const foregroundProcess = await host.getForegroundProcess(ptyId)
      if (isExpectedAgentProcess(foregroundProcess, expectedProcess)) {
        return ptyId
      }
      if (attempt >= 4 && !isShellProcess(foregroundProcess ?? '')) {
        if ((await host.hasChildProcesses?.(ptyId).catch(() => false)) ?? false) {
          return ptyId
        }
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return null
}

export type StartupDraftReadinessOptions = {
  timeoutMs?: number
  requireComposerMarker?: boolean
  signal?: AbortSignal
  /** Veto unsafe screen input while continuing to scan for the next marker or quiet window. */
  accept?: (ptyId: string) => boolean | Promise<boolean>
  /** Ignore shell-owned bracketed paste before the last ?2004l and reject signals while a shell is proven in front. */
  isShellInFront?: (ptyId: string) => Promise<boolean>
  /** Enter follows the paste, so the agent's submit signal is waited for instead of its draft one. */
  submit?: boolean
}

export function waitForWorktreeStartupDraft(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent,
  options: StartupDraftReadinessOptions = {}
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId || options.signal?.aborted) {
    return Promise.resolve(null)
  }
  const signal = resolvePasteReadySignal(TUI_AGENT_CONFIG[agent], options.submit === true)
  const generation = host.generation?.(ptyId)
  return waitForGeneratedAgentInput(
    {
      subscribe: (observe) => host.subscribeToData(ptyId, observe),
      replay: () => host.readRecentOutput(ptyId),
      ...(host.bracketedPaste ? { bracketedPaste: () => host.bracketedPaste!(ptyId) } : {}),
      // Launch readiness observes with the same rule every generated write is admitted by.
      accept: async (quiet) => {
        if (options.accept && !(await options.accept(ptyId))) {
          return false
        }
        if (options.isShellInFront && (await options.isShellInFront(ptyId))) {
          return false
        }
        const foreground = await host.getForegroundProcess(ptyId)
        const hasChildProcesses =
          foreground !== null && isAgentForegroundWrapperProcess(foreground)
            ? ((await host.hasChildProcesses?.(ptyId)) ?? false)
            : false
        const screen = host.readInputScreen
          ? await host.readInputScreen(ptyId)
          : { lines: [], alternateScreen: false }
        return (
          host.getPtyId(handle) === ptyId &&
          host.generation?.(ptyId) === generation &&
          admitsGeneratedInput({
            agent,
            screen,
            quiet,
            process: foreground ? { known: true, foreground, hasChildProcesses } : { known: false }
          })
        )
      }
    },
    signal,
    { ...options, timeoutMs: options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent) }
  ).then((ready) => (ready ? ptyId : null))
}
