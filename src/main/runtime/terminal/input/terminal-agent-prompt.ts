import { agentPromptObservationSignal } from './agent-prompt-signals'
import { assertTerminalInputAdmitted } from '../../terminal-input-admission'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/runtime-types'
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
import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../shared/generated-agent-input-readiness'
import {
  runGeneratedInputOperation,
  type GeneratedInputFrameGate,
  type GeneratedInputSource
} from '../../../../shared/generated-input-operation'
import { OrcaRuntimeWithObserveAgentPromptTurn } from './terminal-agent-prompt-turn'

export abstract class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithObserveAgentPromptTurn {
  protected abstract createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number
  ): { arm: () => void; wait: () => Promise<void>; dispose: () => void } | null

  /** Under `wait`, a pre-paste refusal is the hold's to resume rather than the caller's to see. */
  private throwIfAgentPromptPermissionReturned(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (this.isAgentPromptPermissionBlocked(baseline, current)) {
      throw new AgentPromptPermissionReturnedError()
    }
  }

  /** One generated prompt through the shared operation: this host supplies the PTY's facts, its
   *  queue turn, binding checks and writes; the operation decides readiness, admission, deadline
   *  and outcome. Turn observation follows a written prompt inside the same queue turn. */
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions,
    /** Checks that must hold once this prompt reaches the head of the PTY's queue. */
    atTurn?: () => void
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    const observationSignal = agentPromptObservationSignal(options)
    const agent = this.generatedInputAgent(ptyId, options.generatedAgent)
    const deadline = options.inputDeadline ?? Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
    const submit = options.submit !== false
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pty = this.ptysById.get(ptyId)
    // OMP needs paste and submit in one write; the foreground consumer wins, with launchAgent only a startup fallback.
    const submitWithPaste =
      submit && agentPromptSubmitJoinsPasteFrame(pty?.foregroundAgent ?? pty?.launchAgent)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const waitTextCache: AgentPromptWaitTextCache = {}
    const incarnationId = pty?.incarnationId
    const lifecycleSignal = this.getPtyLifecycleSignal(ptyId)
    const deliverySignal = options.signal
      ? AbortSignal.any([options.signal, lifecycleSignal])
      : lifecycleSignal
    // The caller's observation can end the operation only until its text is written.
    const operationAbort = new AbortController()
    let textWritten = false
    const endOperation = (): void => operationAbort.abort()
    deliverySignal.addEventListener('abort', endOperation, { once: true })
    observationSignal?.addEventListener('abort', () => !textWritten && endOperation(), {
      once: true
    })
    if (deliverySignal.aborted || observationSignal?.aborted) {
      endOperation()
    }
    const assertWritable = (): void => {
      assertAgentPromptRequestActive(deliverySignal)
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
      await options.beforeWrite?.(ptyId)
      assertWritable()
    }
    let permissionBaseline: AgentPromptActivity | undefined
    const render: { gate: ReturnType<typeof this.createAgentPromptRenderGate> } = { gate: null }
    let baseline: AgentPromptActivity | undefined
    let submits = 0
    let delivery: RuntimeTerminalPromptDelivery | undefined
    let afterWriteError: unknown
    const writeFrame = (
      gate: GeneratedInputFrameGate,
      frame: 'text' | 'enter',
      data: string,
      typedText: string | undefined,
      enterReserveMs: number
    ): void => {
      assertWritable()
      // A paused terminal refuses the text; the Enter for text already in the composer is not.
      if (frame === 'text') {
        assertTerminalInputAdmitted(this, ptyId, options.inputSource)
      }
      // Nothing is awaited from here to the write.
      this.assertGeneratedInputCommit(ptyId, agent, deadline, typedText, enterReserveMs)
      const taken = gate.dispatching()
      const written = this.ptyController?.write(ptyId, data, options.inputKind) === true
      taken(written)
      if (!written) {
        throw new Error('terminal_not_writable')
      }
    }
    const source: GeneratedInputSource = {
      observe: (onData) => this.subscribeToTerminalData(ptyId, onData),
      replay: () => this.recentPtyOutputById.get(ptyId)?.read(),
      acquire: async (signal) => {
        const release = await this.acquireAgentPromptTurn(ptyId, generation, signal)
        try {
          atTurn?.()
          // A paused terminal or an agent asking for permission refuses at once, as before.
          assertTerminalInputAdmitted(this, ptyId, options.inputSource)
          permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
          if (options.onPermission === 'wait') {
            this.throwIfAgentPromptPermissionReturned(permissionBaseline, permissionBaseline)
          }
          this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
        } catch (error) {
          release()
          throw error
        }
        return release
      },
      read: () => this.readGeneratedInputEvidence(ptyId, generation),
      textCarriesEnter: submitWithPaste,
      enterReserveMs: pasteIngestMs,
      writeText: async (gate) => {
        await callerGuard()
        if (!(await gate.admit())) {
          return false
        }
        const activity = this.getAgentPromptActivity(handle, ptyId)
        if (options.onPermission === 'wait') {
          this.throwIfAgentPromptPermissionReturned(permissionBaseline!, activity)
        }
        this.assertAgentPromptPermissionSafe(permissionBaseline!, activity)
        if (submitWithPaste) {
          baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
        }
        // A ready Claude composer never settles this gate, adding its full 8s cap.
        render.gate = options.composerReady
          ? null
          : this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
        // Claude can lose the start of a large bracketed paste split across writes; send the whole frame together.
        render.gate?.arm()
        const data = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
        // From the text on, only delivery's own abort can stop Enter.
        textWritten = true
        writeFrame(gate, 'text', data, undefined, submit && !submitWithPaste ? pasteIngestMs : -1)
        options.onPasteWritten?.()
        if (submitWithPaste) {
          options.onSubmitWritten?.()
        }
        return true
      },
      settle: (signal) =>
        render.gate
          ? waitForAgentPromptPromise(render.gate.wait(), signal)
          : waitForAgentPromptDelay(
              options.composerReady
                ? AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs
                : options.promptForSchedule
                  ? resolveAgentPromptSubmitDelayForAgent(
                      writeHostPlatform,
                      options.promptForSchedule,
                      this.getPtyAgent(ptyId)
                    )
                  : getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
              signal
            ),
      writeEnter: async (gate) => {
        await callerGuard()
        if (!(await gate.admit(options.promptForSchedule))) {
          return false
        }
        baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
        this.assertAgentPromptPermissionSafe(permissionBaseline!, baseline)
        writeFrame(gate, 'enter', AGENT_PROMPT_SUBMIT, options.promptForSchedule, -1)
        options.onSubmitWritten?.()
        return true
      },
      retry: async (gate, signal) => {
        if (submitWithPaste) {
          return
        }
        submits += await this.resubmitHeldAgentPrompt(
          ptyId,
          generation,
          { ...options, signal },
          {
            baseline: baseline!,
            readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
            prompt: options.promptForSchedule,
            deadline,
            admit: async () => {
              await callerGuard()
              return await gate.admit(options.promptForSchedule)
            },
            write: () =>
              writeFrame(gate, 'enter', AGENT_PROMPT_SUBMIT, options.promptForSchedule, -1),
            heldBudgetMs: getAgentPromptHeldSubmitBudgetMs(
              writeHostPlatform,
              this.getPtyAgent(ptyId),
              pastePayload
            )
          }
        )
      }
    }
    let result: Awaited<ReturnType<typeof runGeneratedInputOperation>>
    try {
      result = await runGeneratedInputOperation(source, {
        agent,
        submit,
        intent: options.generatedIntent ?? 'running',
        deadline,
        signal: operationAbort.signal,
        observedReady: options.observedReady,
        afterWrite: async () => {
          if (!submit) {
            return
          }
          submits += 1
          try {
            delivery = await this.observeAgentPromptTurn(
              handle,
              ptyId,
              generation,
              pastePayload,
              options,
              observationSignal,
              baseline!,
              submits,
              waitTextCache
            )
          } catch (error) {
            afterWriteError = error
          }
        }
      })
    } finally {
      deliverySignal.removeEventListener('abort', endOperation)
    }
    if (result.outcome === 'staged') {
      await result.finished
      render.gate?.dispose()
      return { submits: 0 }
    }
    if (result.outcome === 'delivered') {
      await result.finished
      render.gate?.dispose()
      if (afterWriteError) {
        throw afterWriteError
      }
      return { submits, ...(delivery ? { prompt: delivery } : {}) }
    }
    render.gate?.dispose()
    this.assertAgentPromptGeneration(ptyId, generation)
    if (result.error) {
      throw result.error
    }
    assertAgentPromptRequestActive(observationSignal)
    assertAgentPromptRequestActive(deliverySignal)
    if (result.outcome === 'unconfirmed' && options.suffixFailureError) {
      throw new Error(options.suffixFailureError)
    }
    throw this.generatedInputRefusal(ptyId)
  }
}
