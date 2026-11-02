import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  GENERATED_INPUT_RETIRED,
  GeneratedInputLifetime
} from '../../../../shared/generated-input-lifetime'
import {
  agentPromptHookApplies,
  runAgentPromptPluginHook,
  runTerminalSendPluginHook,
  terminalHookOrderKind,
  TerminalPluginHookOrder,
  terminalSendHookApplies
} from './terminal-send-plugin-hook'

type TerminalSendAction = { text?: string; enter?: boolean; interrupt?: boolean }

/** Text and prompts Orca writes to terminals pass plugin hooks first (`terminal.send`,
 *  `agent.prompt.before`), in order per terminal; with no plugin listing one, a write adds no
 *  await. */
export abstract class OrcaRuntimeWithPluginHookedTerminalInput extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  protected readonly pluginHookOrder = new TerminalPluginHookOrder()

  async sendTerminal(
    handle: string,
    action: TerminalSendAction,
    options: RuntimeTerminalWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const hooked = terminalSendHookApplies(action, options)
    return this.pluginHookOrder.run(
      handle,
      terminalHookOrderKind(hooked, action, options),
      action,
      // Why recheck inputKind: it narrows the type; terminalSendHookApplies already refused replies.
      (value) =>
        options.inputKind === 'query-reply'
          ? Promise.resolve(value)
          : runTerminalSendPluginHook(handle, value, options.inputKind, (text) =>
              this.assertRewrittenTerminalTextAllowed(text)
            ),
      (final) => this.sendTerminalAfterPluginHooks(handle, final, options)
    )
  }

  /** A generated prompt's lifetime starts here, at acceptance, before plugin-hook ordering: hooks,
   *  a restored pane's start, a permission hold and the queue all spend it, and a hook decision
   *  that arrives after it ended delivers nothing. The hook runs once per request. */
  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const lifetime =
      options.generatedLifetime ??
      new GeneratedInputLifetime({
        deadline: options.inputDeadline ?? null,
        signal: options.signal,
        untilTextSignal: options.observationSignal,
        submit: options.submit !== false
      })
    // Once a frame may have been written, the delivery's own result is the request's answer.
    let written = false
    const reportOutcome = options.onGeneratedOutcome
    options = {
      ...options,
      generatedLifetime: lifetime,
      onGeneratedOutcome: (outcome) => {
        written = true
        reportOutcome?.(outcome)
      }
    }
    const hooked = agentPromptHookApplies(options)
    const hooks = this.pluginHookOrder.run(
      handle,
      terminalHookOrderKind(hooked, {}, options),
      prompt,
      (value) => {
        const pty = this.getLivePtyForHandle(handle)?.pty
        return runAgentPromptPluginHook(
          {
            handle,
            prompt: value,
            inputKind: options.inputKind,
            agent: pty?.foregroundAgent ?? pty?.launchAgent ?? null
          },
          (text) => this.assertRewrittenTerminalTextAllowed(text)
        )
      },
      // Why outside the order: a delivery may wait on a permission answer (`onPermission: 'wait'`).
      (final) => {
        if (lifetime.retired) {
          return Promise.reject(GENERATED_INPUT_RETIRED)
        }
        return this.sendAgentPromptAfterPluginHooks(handle, final, options)
      }
    )
    try {
      return await lifetime.within(hooks)
    } catch (error) {
      if (error !== GENERATED_INPUT_RETIRED) {
        throw error
      }
      if (written) {
        return await hooks
      }
      // Ended before its operation settled anything: nothing was written.
      if (options.signal?.aborted || options.observationSignal?.aborted) {
        throw new Error('request_aborted')
      }
      throw this.generatedInputRefusal(this.getLivePtyForHandle(handle)?.pty.ptyId ?? '')
    } finally {
      lifetime.retire()
    }
  }

  protected abstract generatedInputRefusal(ptyId: string): Error

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
