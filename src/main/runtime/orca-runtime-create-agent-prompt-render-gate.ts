// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './orca-runtime-write-terminal-agent-prompt'
import {
  CLAUDE_AGENT_PROMPT_RENDER_MARKER,
  CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS,
  CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS
} from './orca-runtime-core'
import type { RuntimeTerminalWait, RuntimeTerminalWaitCondition } from '../../shared/runtime-types'

export class OrcaRuntimeWithCreateAgentPromptRenderGate extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  protected createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number
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
    // Why absolute: the ingest clock starts once, here, but the cap is armed twice (at arm()
    // and again on the marker). Re-adding the whole window would charge ingest twice.
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
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearGateTimers()
      resolveRender()
    }
    const armQuietTimer = (): void => {
      // Why: the quiet window measures the agent going still after a *complete* paste.
      // Silence during ingest is not settlement, so it cannot start the clock.
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
    })
    return {
      arm: () => {
        armed = true
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
        unsubscribe()
        clearGateTimers()
      }
    }
  }

  waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeTerminalWait> {
    return this.terminalWait.wait(handle, options)
  }
}
