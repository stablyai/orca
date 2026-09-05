import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG, type DraftPasteReadySignal } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const BRACKETED_PASTE_QUIET_MS = 1500

export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string) => void
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
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`)
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
      host.write(ptyId, `${followup.prompt}\r`)
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

export function waitForWorktreeStartupDraft(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return Promise.resolve(null)
  }
  return waitForDraftPasteReadySignal(
    host,
    ptyId,
    resolveAgentDraftPasteReadySignal(agent),
    resolveDraftPasteReadyTimeoutMs(agent)
  ).then((ready) => (ready ? ptyId : null))
}

export function resolveAgentDraftPasteReadySignal(agent: TuiAgent | null): DraftPasteReadySignal {
  return (
    (agent ? TUI_AGENT_CONFIG[agent].draftPasteReadySignal : undefined) ??
    'render-quiet-after-bracketed-paste'
  )
}

export type DraftPasteReadyHost = Pick<
  WorktreeStartupReadinessHost,
  'subscribeToData' | 'readRecentOutput'
>

/** Composer readiness from the agent's marker (or quiet window) over the replayed recent output
 *  plus the live stream; false on the hard timeout or abort. Shared by the startup draft and the
 *  agent-prompt paste so the two delivery paths cannot drift. */
export function waitForDraftPasteReadySignal(
  host: DraftPasteReadyHost,
  ptyId: string,
  readySignal: DraftPasteReadySignal,
  hardTimeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(readySignal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    const finish = (value: boolean): void => {
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
      signal?.removeEventListener('abort', onAbort)
      unsubscribe?.()
      resolve(value)
    }
    const onAbort = (): void => finish(false)
    const observe = (data: string): void => {
      const result = scanner.observe(data)
      if (result.ready) {
        return finish(true)
      }
      if (result.armQuietTimer) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(() => finish(true), BRACKETED_PASTE_QUIET_MS)
      }
    }
    unsubscribe = host.subscribeToData(ptyId, observe)
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
    if (settled) {
      return
    }
    if (signal?.aborted) {
      finish(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    hardTimer = setTimeout(() => finish(false), hardTimeoutMs)
  })
}
