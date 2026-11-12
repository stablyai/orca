import { OrcaRuntimeWithSubmitTerminalAgentPrompt } from './terminal-agent-prompt-submit'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../../../shared/runtime-terminal-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isCompleteAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'
const CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000

const CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS = 1500

/** How long a composer must keep showing the whole paste before Enter, outlasting paste-burst windows. */
const AGENT_PROMPT_RENDER_DRAFT_SETTLE_MS = 300

// Claude shows its cursor before composer rendering settles.
const CLAUDE_AGENT_PROMPT_RENDER_MARKER = '\x1b[?25h'

export abstract class OrcaRuntimeWithCreateAgentPromptRenderGate extends OrcaRuntimeWithSubmitTerminalAgentPrompt {
  protected createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number,
    prompt?: string
  ): {
    arm: () => void
    wait: () => Promise<void>
    dispose: () => void
  } | null {
    const pty = this.ptysById.get(ptyId)
    if (!['claude', 'codex'].includes(pty?.launchAgent ?? pty?.foregroundAgent ?? '')) {
      return null
    }
    let armed = false
    let observedMarker = false
    let settled = false
    let ingested = pasteIngestMs <= 0
    // Arm and marker both set this cap; use an absolute deadline to avoid charging ingest twice.
    const ingestDeadlineAt = Date.now() + pasteIngestMs
    let markerCarry = ''
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let ingestTimer: NodeJS.Timeout | null = null
    let resolveRender!: () => void
    const rendered = new Promise<void>((resolve) => {
      resolveRender = resolve
    })

    const clearGateTimers = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
        hardTimer = null
      }
      if (ingestTimer) {
        clearTimeout(ingestTimer)
        ingestTimer = null
      }
      if (draftSettleTimer) {
        clearTimeout(draftSettleTimer)
        draftSettleTimer = null
      }
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      composerProof = false
      clearGateTimers()
      resolveRender()
    }
    const armQuietTimer = (): void => {
      // Quiet starts after complete ingestion; silence during paste cannot settle it.
      if (!ingested) {
        return
      }
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      quietTimer = setTimeout(finish, CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS)
    }
    const armHardTimer = (): void => {
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      hardTimer = setTimeout(
        finish,
        CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS + Math.max(0, ingestDeadlineAt - Date.now())
      )
    }
    // Child work can repaint forever; a composer that keeps showing exactly this paste proves it
    // landed. Only from an empty composer: text already there cannot be told from the new paste.
    let composerProof = false
    let draftRead: Promise<void> | null = null
    let draftMatchedAt: number | null = null
    let draftSettleTimer: NodeJS.Timeout | null = null
    const checkComposerDraft = (): void => {
      if (!composerProof || prompt === undefined || !observedMarker || !ingested || draftRead) {
        return
      }
      // The read waits for the screen model to catch up; typed text then excludes a dim suggestion.
      draftRead = this.readCurrentTerminalWaitScreen(ptyId)
        .then((screen) => {
          if (!composerProof) {
            return
          }
          const typed = screen ? this.readCaughtUpComposerTypedText(ptyId) : null
          if (!isCompleteAgentPromptDraft(typed, prompt)) {
            draftMatchedAt = null
            return
          }
          draftMatchedAt ??= Date.now()
          const settleLeftMs = draftMatchedAt + AGENT_PROMPT_RENDER_DRAFT_SETTLE_MS - Date.now()
          if (settleLeftMs <= 0) {
            finish()
          } else if (!draftSettleTimer) {
            draftSettleTimer = setTimeout(() => {
              draftSettleTimer = null
              checkComposerDraft()
            }, settleLeftMs)
          }
        })
        .catch(() => undefined)
        .finally(() => {
          draftRead = null
        })
    }
    const armIngestTimer = (): void => {
      if (ingested || ingestTimer) {
        return
      }
      ingestTimer = setTimeout(
        () => {
          ingestTimer = null
          ingested = true
          if (observedMarker) {
            armQuietTimer()
            checkComposerDraft()
          }
        },
        Math.max(0, ingestDeadlineAt - Date.now())
      )
    }
    const unsubscribe = this.subscribeToTerminalData(ptyId, (data) => {
      if (!armed || settled) {
        return
      }
      if (!observedMarker) {
        const combined = markerCarry + data
        markerCarry = combined.slice(-(CLAUDE_AGENT_PROMPT_RENDER_MARKER.length - 1))
        if (!combined.includes(CLAUDE_AGENT_PROMPT_RENDER_MARKER)) {
          return
        }
        observedMarker = true
        armHardTimer()
      }
      armQuietTimer()
      checkComposerDraft()
    })
    return {
      arm: () => {
        armed = true
        composerProof = prompt !== undefined && this.readCaughtUpComposerTypedText(ptyId) === ''
        markerCarry = ''
        armIngestTimer()
        armHardTimer()
      },
      wait: async () => {
        if (settled) {
          return
        }
        await rendered
      },
      dispose: () => {
        composerProof = false
        unsubscribe()
        clearGateTimers()
      }
    }
  }

  /** The user's text in a composer the screen model has fully caught up on; null when unknown. */
  protected readCaughtUpComposerTypedText(ptyId: string): string | null {
    const state = this.readWholeScreenModel(ptyId)
    return state && state.outputSequence === this.getPtyOutputSequence(ptyId)
      ? readTerminalComposerTypedText(state.emulator.getCursorLineContext())
      : null
  }

  waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
      launchReadiness?: boolean
    }
  ): Promise<RuntimeTerminalWait> {
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN
      ? this.startRestoredHandlePane(handle, options ?? {})
      : null
    if (starting) {
      const startedAt = Date.now()
      return starting.then(async (target) => {
        // The start spent part of the caller's deadline.
        const timeoutMs = options?.timeoutMs
        const left = timeoutMs && timeoutMs > 0 ? timeoutMs - (Date.now() - startedAt) : timeoutMs
        if (timeoutMs && timeoutMs > 0 && left !== undefined && left <= 0) {
          throw new Error('timeout')
        }
        return {
          ...(await this.terminalWait.wait(target, { ...options, timeoutMs: left })),
          handle
        }
      })
    }
    return this.terminalWait.wait(handle, options)
  }
}
