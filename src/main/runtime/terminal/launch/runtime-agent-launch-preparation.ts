import type { SessionOptionValue } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './terminal-create-options'
import {
  resolveAgentTerminalCreateOptions,
  prepareHostAgentTerminalLaunch
} from './runtime-agent-terminal-startup'
import { RuntimeTerminalNames } from '../title/runtime-terminal-names'

export abstract class RuntimeAgentLaunchPreparation extends RuntimeTerminalNames {
  async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions,
    sessionOptions: Readonly<Record<string, SessionOptionValue>> | undefined = opts.sessionOptions
  ): Promise<TerminalCreateOptions> {
    const resolvedLaunch = await resolveAgentTerminalCreateOptions(
      workspace,
      opts,
      {
        store: this.store,
        hostIdentity: this.runtimeId,
        toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
      },
      sessionOptions
    )
    return prepareHostAgentTerminalLaunch(workspace, opts, resolvedLaunch, this.accounts)
  }
}
