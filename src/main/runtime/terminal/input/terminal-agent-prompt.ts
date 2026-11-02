import { agentPromptObservationSignal } from './agent-prompt-signals'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/runtime-types'
import { assertAgentPromptRequestActive } from '../../orca-runtime-core'
import { runGeneratedInputOperation } from '../../../../shared/generated-input-operation'
import { GeneratedInputLifetime } from '../../../../shared/generated-input-lifetime'
import {
  OrcaRuntimeWithAgentPromptSource,
  type AgentPromptRetarget
} from './terminal-agent-prompt-source'

export abstract class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithAgentPromptSource {
  /** One attempt of a generated prompt through the shared operation: this host supplies the PTY's
   *  facts, queue turn, checks and writes; the operation decides readiness, admission and outcome.
   *  The request's lifetime (from its acceptance) bounds the attempt; turn observation follows a
   *  written prompt inside the same queue turn. */
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    _generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions,
    /** Checks that must hold once this prompt reaches the head of its PTY's queue. */
    atTurn?: (ptyId: string) => void,
    retarget?: AgentPromptRetarget
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    const observationSignal = agentPromptObservationSignal(options)
    const submit = options.submit !== false
    const request =
      options.generatedLifetime ??
      new GeneratedInputLifetime({
        deadline: options.inputDeadline ?? null,
        signal: options.signal,
        untilTextSignal: options.observationSignal,
        submit
      })
    const attempt = request.attempt()
    const first = this.bindAgentPromptTarget(ptyId, pastePayload, options)
    const { source, state } = this.createAgentPromptSource(
      handle,
      first,
      options,
      attempt,
      atTurn,
      retarget
    )
    let delivery: RuntimeTerminalPromptDelivery | undefined
    let afterWriteError: unknown
    const result = await runGeneratedInputOperation(source, {
      agent: first.agent,
      // A follow-up was authorized for the caller's agent; the target's resolved agent frames it.
      ...(options.requireConsumer && options.generatedAgent !== undefined
        ? { consumer: options.generatedAgent }
        : {}),
      submit,
      intent: options.generatedIntent ?? 'running',
      lifetime: attempt,
      observedReady: options.observedReady,
      requireConsumer: options.requireConsumer,
      afterWrite: async () => {
        if (!submit) {
          return
        }
        state.submits += 1
        try {
          delivery = await this.observeAgentPromptTurn(
            handle,
            state.target.ptyId,
            state.target.generation,
            state.target.payload,
            options,
            observationSignal,
            state.baseline!,
            state.submits,
            state.waitTextCache
          )
        } catch (error) {
          afterWriteError = error
        }
      }
    })
    if (result.outcome !== 'not-sent') {
      options.onGeneratedOutcome?.(result.outcome)
    }
    if (result.outcome === 'staged' || result.outcome === 'delivered') {
      await result.finished
      state.render?.dispose()
      if (afterWriteError) {
        throw afterWriteError
      }
      return result.outcome === 'staged'
        ? { submits: 0 }
        : { submits: state.submits, ...(delivery ? { prompt: delivery } : {}) }
    }
    state.render?.dispose()
    this.assertAgentPromptGeneration(state.target.ptyId, state.target.generation)
    if (result.error) {
      throw result.error
    }
    assertAgentPromptRequestActive(observationSignal)
    assertAgentPromptRequestActive(options.signal)
    if (result.outcome === 'unconfirmed' && options.suffixFailureError) {
      throw new Error(options.suffixFailureError)
    }
    throw this.generatedInputRefusal(state.target.ptyId)
  }
}
