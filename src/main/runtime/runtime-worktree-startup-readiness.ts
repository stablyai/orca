import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import {
  createDraftPasteReadyScanner,
  resolvePasteReadySignal
} from '../../shared/draft-paste-ready-scanner'
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
const BRACKETED_PASTE_QUIET_MS = 1500
// Shells enable bracketed paste at their prompt; only markers after the last command handoff (?2004l) belong to the agent.
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// Bound the final foreground read so a past-due wait cannot hang on SSH's 30s channel timeout.
const DEADLINE_SETTLE_CHECK_MS = 2_000

export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  void waitForWorktreeStartupDraft(host, handle, draft.agent)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`, 'launch')
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}

/** A post-start agent's first prompt: its process in front can still drop typed text (#10336). */
export async function deliverStartupFollowupPrompt(
  runtime: TerminalPromptRuntime,
  host: WorktreeStartupReadinessHost,
  handle: string,
  { agent, prompt }: WorktreeStartupFollowup,
  options: { signal?: AbortSignal; agentLaunch?: boolean } = {}
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
        return false
      }
      // WSL and SSH-to-Windows cannot prove a lone shell either: keep their typed follow-up; agent.launch refused there.
      if (!options.agentLaunch && runtime.launchedAgentHostProvesShellAlone?.(ptyId) !== true) {
        host.write(ptyId, `${prompt}\r`, 'launch')
        return true
      }
    }
    return await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent,
      freshLaunch: true,
      text: prompt,
      unprovableHost: 'write-if-shell-provable',
      ...(signal ? { signal } : {})
    })
  } catch (error) {
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
  const isShellInFront = options.isShellInFront
  return new Promise((resolve) => {
    let settled = false
    let scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    // After submit grace expires, each subsequent matching read is a signal and must pass settle checks.
    let graceTimer: NodeJS.Timeout | null = null
    let graceElapsed = false
    let hardTimer: NodeJS.Timeout | null = null
    let deadlineCheckTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    // A check begun before a shell handoff cannot settle after it.
    let handoffs = 0
    let handoffCarry = ''
    let checking = false
    /** The hand-off count at a signal that fired while a check ran. */
    let recheckAt: number | null = null
    const onAbort = (): void => finish(null)
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      clearGrace()
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      if (deadlineCheckTimer) {
        clearTimeout(deadlineCheckTimer)
      }
      unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const clearGrace = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      graceElapsed = false
    }
    /** The screen holds nothing the input must not answer and no shell is proven in front. */
    const passesSettleChecks = async (): Promise<boolean> =>
      (!options.accept || (await options.accept(ptyId))) &&
      !(isShellInFront && (await isShellInFront(ptyId)))
    /** Settles a fired signal once its screen is clear and no shell is proven in front. */
    const settleSignal = async (signalHandoffs: number): Promise<void> => {
      checking = true
      try {
        if (!(await passesSettleChecks())) {
          return
        }
        if (signalHandoffs === handoffs) {
          finish(ptyId)
        }
      } catch {
        // Failed settle checks wait for the next agent signal.
      } finally {
        checking = false
        const next = recheckAt
        recheckAt = null
        if (next === handoffs && !settled) {
          void settleSignal(next)
        }
      }
    }
    const onSignal = (): void => {
      if (checking) {
        recheckAt = handoffs
        return
      }
      void settleSignal(handoffs)
    }
    /** The part of a chunk after the shell's last hand-off in it, resetting the scan at one. */
    const sinceShellHandoff = (chunk: string): string => {
      const window = handoffCarry + chunk
      // Retain one byte less than the sequence to rejoin split handoffs without double counting.
      handoffCarry = window.slice(-(DECRST_BRACKETED_PASTE.length - 1))
      const handoff = window.lastIndexOf(DECRST_BRACKETED_PASTE)
      if (handoff === -1) {
        return chunk
      }
      handoffs += 1
      scanner = createDraftPasteReadyScanner(signal)
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      clearGrace()
      return window.slice(handoff + DECRST_BRACKETED_PASTE.length)
    }
    const observe = (chunk: string): void => {
      if (settled) {
        return
      }
      const data = isShellInFront ? sinceShellHandoff(chunk) : chunk
      const result = scanner.observe(data)
      if (result.ready) {
        return onSignal()
      }
      if (result.readyAfterMs === null) {
        clearGrace()
      } else if (typeof result.readyAfterMs === 'number') {
        if (graceElapsed) {
          onSignal()
        } else if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null
            graceElapsed = true
            onSignal()
          }, result.readyAfterMs)
        }
      }
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(onSignal, BRACKETED_PASTE_QUIET_MS)
      }
    }
    options.signal?.addEventListener('abort', onAbort)
    unsubscribe = host.subscribeToData(ptyId, observe)
    // A deadline during submit grace gets one final settle check.
    const onDeadline = (): void => {
      if (!graceTimer && !graceElapsed) {
        return finish(null)
      }
      const deadlineHandoffs = handoffs
      deadlineCheckTimer = setTimeout(() => finish(null), DEADLINE_SETTLE_CHECK_MS)
      void passesSettleChecks().then(
        (passes) => finish(passes && deadlineHandoffs === handoffs ? ptyId : null),
        () => finish(null)
      )
    }
    hardTimer = setTimeout(onDeadline, options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent))
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
  })
}
