import { waitForGeneratedAgentInput } from '../../shared/generated-agent-input-readiness'
import { findAgentInputDialogIndex } from '../../shared/agent-input-dialog'
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
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import {
  deliverTerminalAgentLaunchPrompt,
  type TerminalPromptRuntime
} from './rpc/methods/agent-launch-terminal-prompt'

const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  readInputScreen?: (ptyId: string) => Promise<readonly string[] | null>
  generation?: (ptyId: string) => number
  recover?: (certainty: 'not-sent' | 'unconfirmed') => void
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  const deadline = Date.now() + resolveDraftPasteReadyTimeoutMs(draft.agent)
  const targetPty = host.getPtyId(handle)
  const generation = targetPty ? host.generation?.(targetPty) : undefined
  void waitForWorktreeStartupDraft(host, handle, draft.agent)
    .then(async (ptyId) => {
      if (
        !ptyId ||
        ptyId !== targetPty ||
        !(await startupInputIsClear(host, ptyId)) ||
        isShellProcess((await host.getForegroundProcess(ptyId)) ?? '') ||
        Date.now() >= deadline ||
        host.getPtyId(handle) !== ptyId ||
        host.generation?.(ptyId) !== generation
      ) {
        host.recover?.('not-sent')
        return
      }
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`, 'launch')
    })
    .catch(() => host.recover?.('unconfirmed'))
}

export type StartupFollowupPromptOptions = {
  signal?: AbortSignal
  agentLaunch?: boolean
  terminalCreation?: TerminalReadinessCreation
  onRefused?: (certainty: 'not-sent' | 'unconfirmed') => void
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
  const deadline = Date.now() + resolveDraftPasteReadyTimeoutMs(agent)
  let wrote = false
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
        const generation = host.generation?.(ptyId)
        const readyPty = await waitForWorktreeStartupDraft(host, handle, agent, {
          signal,
          submit: true,
          timeoutMs: Math.max(0, deadline - Date.now())
        })
        if (readyPty !== ptyId) {
          options.onRefused?.('not-sent')
          return false
        }
        const admitted = async (): Promise<boolean> => {
          const foreground = await host.getForegroundProcess(ptyId)
          return (
            !isShellProcess(foreground ?? '') &&
            (await startupInputIsClear(host, ptyId)) &&
            !signal?.aborted &&
            Date.now() < deadline &&
            host.getPtyId(handle) === ptyId &&
            host.generation?.(ptyId) === generation
          )
        }
        if (!(await admitted())) {
          options.onRefused?.('not-sent')
          return false
        }
        wrote = true
        host.write(ptyId, prompt, 'launch')
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!(await admitted())) {
          options.onRefused?.('unconfirmed')
          return false
        }
        host.write(ptyId, '\r', 'launch')
        return true
      }
    }
    return await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent,
      freshLaunch: true,
      terminalCreation: options.terminalCreation,
      text: prompt,
      inputDeadline: deadline,
      unprovableHost: 'write-if-shell-provable',
      onRefused: options.onRefused,
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    options.onRefused?.(wrote ? 'unconfirmed' : 'not-sent')
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
      accept: async (quiet) => {
        if (!(await startupInputIsClear(host, ptyId))) {
          return false
        }
        if (options.accept && !(await options.accept(ptyId))) {
          return false
        }
        if (options.isShellInFront && (await options.isShellInFront(ptyId))) {
          return false
        }
        const foreground = await host.getForegroundProcess(ptyId)
        if (isShellProcess(foreground ?? '')) {
          return false
        }
        if (quiet && !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)) {
          if (
            !isAgentForegroundWrapperProcess(foreground ?? '') ||
            !(await host.hasChildProcesses?.(ptyId))
          ) {
            return false
          }
        }
        return (
          host.getPtyId(handle) === ptyId &&
          host.generation?.(ptyId) === generation &&
          (await startupInputIsClear(host, ptyId))
        )
      }
    },
    signal,
    { ...options, timeoutMs: options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent) }
  ).then((ready) => (ready ? ptyId : null))
}

async function startupInputIsClear(
  host: WorktreeStartupReadinessHost,
  ptyId: string
): Promise<boolean> {
  if (!host.readInputScreen) {
    return true
  }
  const screen = await host.readInputScreen(ptyId)
  return screen !== null && findAgentInputDialogIndex(screen.join('\n')) === null
}
