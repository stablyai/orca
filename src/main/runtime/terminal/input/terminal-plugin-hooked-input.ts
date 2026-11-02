import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal-input-dispatch'
import {
  runTerminalSendPluginHook,
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

  /** The checks callers ran on the original text, run again on what a plugin wrote. */
  protected async assertRewrittenTerminalTextAllowed(text: string): Promise<void> {
    await assertLegacyAiVaultResumeCommandAllowed(text, () =>
      this.ensureStructuredAgentSessionHost()
    )
  }
}
