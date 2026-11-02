import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import {
  runTerminalSendPluginHook,
  terminalHookOrderKind,
  TerminalPluginHookOrder,
  terminalSendHookApplies
} from './terminal-send-plugin-hook'

type TerminalSendAction = { text?: string; enter?: boolean; interrupt?: boolean }

/** Text Orca writes to terminals passes plugin hooks first; with no plugin listing one, a write
 *  adds no await. */
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

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
