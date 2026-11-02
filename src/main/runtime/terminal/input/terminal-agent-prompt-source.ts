import { assertTerminalInputAdmitted } from '../../terminal-input-admission'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from '../../orca-runtime-core'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptHeldSubmitBudgetMs,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../../shared/agent-prompt-injection'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from '../../agent-prompt-submission-verification'
import type {
  GeneratedInputFrameGate,
  GeneratedInputSource
} from '../../../../shared/generated-input-operation'
import type { GeneratedInputLifetime } from '../../../../shared/generated-input-lifetime'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import { OrcaRuntimeWithObserveAgentPromptTurn } from './terminal-agent-prompt-turn'

type RenderGate = { arm: () => void; wait: () => Promise<void>; dispose: () => void }

/** A default send's target can be looked up again when its turn opens (main's mutable leaf). */
export type AgentPromptRetarget = {
  resolve: () => string | null
  payloadFor: (ptyId: string) => string
}

/** The PTY one attempt writes to; replaced only before any byte, then pinned. */
export type AgentPromptTarget = {
  ptyId: string
  generation: number
  incarnationId: string | undefined
  payload: string
  agent: TuiAgent | null
  submitWithPaste: boolean
  pasteIngestMs: number
}

export type AgentPromptSourceState = {
  target: AgentPromptTarget
  render: RenderGate | null
  baseline: AgentPromptActivity | undefined
  submits: number
  waitTextCache: AgentPromptWaitTextCache
}

/** The PTY host as a generated-input source: its facts, queue turn, checks and writes. */
export abstract class OrcaRuntimeWithAgentPromptSource extends OrcaRuntimeWithObserveAgentPromptTurn {
  protected abstract createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number
  ): RenderGate | null

  protected bindAgentPromptTarget(
    ptyId: string,
    payload: string,
    options: RuntimeAgentPromptWriteOptions
  ): AgentPromptTarget {
    const pty = this.ptysById.get(ptyId)
    const submit = options.submit !== false
    return {
      ptyId,
      generation: this.getPtyLifecycleGeneration(ptyId),
      incarnationId: pty?.incarnationId,
      payload,
      agent: this.generatedInputAgent(ptyId, options.generatedAgent),
      // OMP needs paste and submit in one write; the foreground consumer wins.
      submitWithPaste:
        submit && agentPromptSubmitJoinsPasteFrame(pty?.foregroundAgent ?? pty?.launchAgent),
      pasteIngestMs: getTerminalPasteIngestMs(
        this.getPtyWriteHostPlatform(ptyId),
        Buffer.byteLength(payload, 'utf8')
      )
    }
  }

  protected createAgentPromptSource(
    handle: string,
    first: AgentPromptTarget,
    options: RuntimeAgentPromptWriteOptions,
    attempt: GeneratedInputLifetime,
    atTurn: ((ptyId: string) => void) | undefined,
    retarget: AgentPromptRetarget | undefined
  ): { source: GeneratedInputSource; state: AgentPromptSourceState } {
    const state: AgentPromptSourceState = {
      target: first,
      render: null,
      baseline: undefined,
      submits: 0,
      waitTextCache: {}
    }
    const submit = options.submit !== false
    let permissionBaseline: AgentPromptActivity | undefined
    let retargeted = false
    const assertWritable = (): void => {
      const { ptyId, generation, incarnationId } = state.target
      assertAgentPromptRequestActive(attempt.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      if (incarnationId != null && this.ptysById.get(ptyId)?.incarnationId !== incarnationId) {
        throw new Error('terminal_handle_stale')
      }
      this.assertAgentPromptExpectedBinding(handle, options.expectedBinding)
      if (this.isPtyStopRequested(ptyId)) {
        throw new Error('terminal_not_writable')
      }
    }
    const callerGuard = async (): Promise<void> => {
      assertWritable()
      await options.beforeWrite?.(state.target.ptyId)
      assertWritable()
    }
    const checkPermission = (current: AgentPromptActivity): void => {
      if (
        options.onPermission === 'wait' &&
        this.isAgentPromptPermissionBlocked(permissionBaseline!, current)
      ) {
        throw new AgentPromptPermissionReturnedError()
      }
      this.assertAgentPromptPermissionSafe(permissionBaseline!, current)
    }
    const writeFrame = (
      gate: GeneratedInputFrameGate,
      frame: 'text' | 'enter',
      data: string,
      typedText: string | undefined,
      enterReserveMs: number
    ): void => {
      assertWritable()
      const { ptyId, agent } = state.target
      // A paused terminal refuses the text; the Enter for text already in the composer is not.
      if (frame === 'text') {
        assertTerminalInputAdmitted(this, ptyId, options.inputSource)
      }
      // Nothing is awaited from here to the write.
      this.assertGeneratedInputCommit(
        ptyId,
        agent,
        attempt.deadline ?? 0,
        typedText,
        enterReserveMs
      )
      const taken = gate.dispatching()
      const written = this.ptyController?.write(ptyId, data, options.inputKind) === true
      taken(written)
      if (!written) {
        throw new Error('terminal_not_writable')
      }
    }
    const source: GeneratedInputSource = {
      observe: (onData) => this.subscribeToTerminalData(state.target.ptyId, onData),
      replay: () => this.recentPtyOutputById.get(state.target.ptyId)?.read(),
      acquire: async (signal) => {
        for (;;) {
          const { ptyId, generation } = state.target
          const release = await this.acquireAgentPromptTurn(ptyId, generation, signal)
          // A default send looks its leaf up again when its turn opens; a replacement is a new
          // target with its own turn, framing and evidence. No byte has left yet.
          const next = retarget?.resolve()
          if (next && next !== ptyId) {
            release()
            state.target = this.bindAgentPromptTarget(next, retarget!.payloadFor(next), options)
            retargeted = true
            continue
          }
          try {
            atTurn?.(ptyId)
            // A paused terminal or an agent asking for permission refuses at once, as before.
            assertTerminalInputAdmitted(this, ptyId, options.inputSource)
            permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
            checkPermission(permissionBaseline)
            attempt.endOn(this.getPtyLifecycleSignal(ptyId))
          } catch (error) {
            release()
            throw error
          }
          return release
        }
      },
      takeRetarget: () => {
        const was = retargeted
        retargeted = false
        return was
      },
      read: () => this.readGeneratedInputEvidence(state.target.ptyId, state.target.generation),
      get textCarriesEnter() {
        return state.target.submitWithPaste
      },
      get enterReserveMs() {
        return state.target.pasteIngestMs
      },
      writeText: async (gate) => {
        await callerGuard()
        if (!(await gate.admit())) {
          return false
        }
        const { ptyId, submitWithPaste, pasteIngestMs, payload } = state.target
        checkPermission(this.getAgentPromptActivity(handle, ptyId))
        if (submitWithPaste) {
          state.baseline = this.getAgentPromptActivity(handle, ptyId, state.waitTextCache)
        }
        // A ready Claude composer never settles this gate, adding its full 8s cap.
        state.render = options.composerReady
          ? null
          : this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
        // Claude can lose the start of a large bracketed paste split across writes.
        state.render?.arm()
        const data = submitWithPaste ? payload + AGENT_PROMPT_SUBMIT : payload
        writeFrame(gate, 'text', data, undefined, submit && !submitWithPaste ? pasteIngestMs : -1)
        options.onPasteWritten?.()
        if (submitWithPaste) {
          options.onSubmitWritten?.()
        }
        return true
      },
      settle: (signal) => {
        const { ptyId, payload, pasteIngestMs } = state.target
        if (state.render) {
          return waitForAgentPromptPromise(state.render.wait(), signal)
        }
        const platform = this.getPtyWriteHostPlatform(ptyId)
        return waitForAgentPromptDelay(
          options.composerReady
            ? AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs
            : options.promptForSchedule
              ? resolveAgentPromptSubmitDelayForAgent(
                  platform,
                  options.promptForSchedule,
                  this.getPtyAgent(ptyId)
                )
              : getAgentPromptSubmitDelayMs(platform, Buffer.byteLength(payload, 'utf8')),
          signal
        )
      },
      writeEnter: async (gate) => {
        await callerGuard()
        if (!(await gate.admit(options.promptForSchedule))) {
          return false
        }
        const { ptyId } = state.target
        state.baseline = this.getAgentPromptActivity(handle, ptyId, state.waitTextCache)
        this.assertAgentPromptPermissionSafe(permissionBaseline!, state.baseline)
        writeFrame(gate, 'enter', AGENT_PROMPT_SUBMIT, options.promptForSchedule, -1)
        options.onSubmitWritten?.()
        return true
      },
      retry: async (gate, signal) => {
        const { ptyId, generation, submitWithPaste, payload } = state.target
        if (submitWithPaste) {
          return
        }
        state.submits += await this.resubmitHeldAgentPrompt(
          ptyId,
          generation,
          { ...options, signal },
          {
            baseline: state.baseline!,
            readActivity: () => this.getAgentPromptActivity(handle, ptyId, state.waitTextCache),
            prompt: options.promptForSchedule,
            deadline: attempt.deadline ?? 0,
            admit: async () => {
              await callerGuard()
              return await gate.admit(options.promptForSchedule)
            },
            write: () =>
              writeFrame(gate, 'enter', AGENT_PROMPT_SUBMIT, options.promptForSchedule, -1),
            heldBudgetMs: getAgentPromptHeldSubmitBudgetMs(
              this.getPtyWriteHostPlatform(ptyId),
              this.getPtyAgent(ptyId),
              payload
            )
          }
        )
      }
    }
    return { source, state }
  }
}
