import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const BRACKETED_PASTE_QUIET_MS = 1500
// Why: an interactive shell turns bracketed paste on at its prompt and off when it runs the typed
// command (`zsh-prompt-runs-command.txt`), so a 2004 before the last `?2004l` is the shell's.
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'

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

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  void waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for follow-up prompt')
        return
      }
      host.write(ptyId, `${followup.prompt}\r`, 'launch')
    })
    .catch((error) =>
      console.warn('[worktree-create] failed to send startup follow-up prompt:', error)
    )
}

export async function waitForWorktreeStartupFollowup(
  host: WorktreeStartupReadinessHost,
  handle: string,
  expectedProcess: string
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return null
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
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
  /** Vetoes a ready signal whose screen still holds something the input must not answer; the
   *  scan continues, so the agent's next marker or quiet window asks again. */
  accept?: (ptyId: string) => boolean | Promise<boolean>
  /**
   * For a launched agent. With it, only output after the shell's last `?2004l` counts, since the
   * shell's own prompt enables bracketed paste too, and a ready signal is dropped while a shell is
   * proven in front: the launch line has not run yet, or the agent exited.
   */
  isShellInFront?: (ptyId: string) => Promise<boolean>
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
  const signal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const isShellInFront = options.isShellInFront
  return new Promise((resolve) => {
    let settled = false
    let scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    // Bumped at each shell hand-off: a check begun before one must not settle the wait after it.
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
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    /** Settles a fired signal once its screen is clear and no shell is proven in front. */
    const settleSignal = async (signalHandoffs: number): Promise<void> => {
      checking = true
      try {
        if (options.accept && !(await options.accept(ptyId))) {
          return
        }
        if (isShellInFront && (await isShellInFront(ptyId))) {
          return
        }
        if (signalHandoffs === handoffs) {
          finish(ptyId)
        }
      } catch {
        // A check that failed is no settle; the agent's next signal asks again.
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
      // Why 7: one short of the sequence, so a split one is rejoined and never counted twice.
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
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(onSignal, BRACKETED_PASTE_QUIET_MS)
      }
    }
    options.signal?.addEventListener('abort', onAbort)
    unsubscribe = host.subscribeToData(ptyId, observe)
    hardTimer = setTimeout(
      () => finish(null),
      options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent)
    )
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
  })
}
