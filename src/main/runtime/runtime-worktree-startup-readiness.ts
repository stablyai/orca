import { isShellProcess } from '../../shared/agent-detection'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  resolveAgentPromptSubmitDelayForAgent
} from '../../shared/agent-prompt-injection'
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
  void waitForWorktreeStartupDraft(host, handle, followup.agent)
    .then(async (ptyId) => {
      if (ptyId) {
        // Why the paste frame: a raw write reaches the composer as keystrokes, so a
        // Kimi-style TUI reads the submit's CR through the pre-raw-mode line
        // discipline as LF (insert-newline) and multi-line prompts keystroke in their
        // embedded LFs. Every other TUI dispatch frames the prompt this way.
        host.write(ptyId, buildAgentPromptPasteBytes(followup.prompt), 'launch')
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            resolveAgentPromptSubmitDelayForAgent(process.platform, followup.prompt, followup.agent)
          )
        )
        host.write(ptyId, AGENT_PROMPT_SUBMIT, 'launch')
        return
      }
      // Why the fallback: a TUI whose ready signal never fires still gets the
      // process-name gate instead of silently dropping the prompt.
      const target = await waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
      if (!target) {
        console.warn('[worktree-create] agent did not become ready for follow-up prompt')
        return
      }
      // Why bare: without the scanner's confirmation bracketed paste may be off, so delimiters would type in as literal input.
      host.write(target, `${followup.prompt}${AGENT_PROMPT_SUBMIT}`, 'launch')
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
  agent: TuiAgent,
  options: { timeoutMs?: number; requireComposerMarker?: boolean } = {}
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return Promise.resolve(null)
  }
  const signal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  return new Promise((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
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
      resolve(value)
    }
    const observe = (data: string): void => {
      if (settled) {
        return
      }
      const result = scanner.observe(data)
      if (result.ready) {
        return finish(ptyId)
      }
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(() => finish(ptyId), BRACKETED_PASTE_QUIET_MS)
      }
    }
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
