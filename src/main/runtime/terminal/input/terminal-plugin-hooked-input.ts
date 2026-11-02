import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  agentPromptHookApplies,
  runAgentPromptPluginHook,
  runTerminalSendPluginHook,
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
    return this.pluginHookOrder.run(handle, hooked, async () => {
      // Why recheck inputKind: it narrows the type; terminalSendHookApplies already refused replies.
      const final =
        hooked && options.inputKind !== 'query-reply'
          ? await runTerminalSendPluginHook(handle, action, options.inputKind, (text) =>
              this.assertRewrittenTerminalTextAllowed(text)
            )
          : action
      return this.sendTerminalAfterPluginHooks(handle, final, options)
    })
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const hooked = agentPromptHookApplies(options)
    return this.pluginHookOrder.run(handle, hooked, async () => {
      const pty = hooked ? this.getLivePtyForHandle(handle)?.pty : undefined
      const final = hooked
        ? await runAgentPromptPluginHook(
            {
              handle,
              prompt,
              inputKind: options.inputKind,
              agent: pty?.foregroundAgent ?? pty?.launchAgent ?? null
            },
            (text) => this.assertRewrittenTerminalTextAllowed(text)
          )
        : prompt
      return this.sendAgentPromptAfterPluginHooks(handle, final, options)
    })
  }

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
