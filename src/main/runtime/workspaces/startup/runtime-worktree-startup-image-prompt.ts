import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { WorktreeStartupFollowup } from './runtime-worktree-agent-startup'
import {
  waitForWorktreeStartupFollowup,
  type StartupFollowupPromptOptions,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'
import {
  deliverTerminalAgentLaunchPrompt,
  type TerminalPromptRuntime
} from '../../rpc/methods/agent-launch-terminal-prompt'

export type StartupImagePromptOptions = StartupFollowupPromptOptions &
  Pick<Parameters<typeof deliverTerminalAgentLaunchPrompt>[0], 'images' | 'onInputWritten'>

/** A launched agent's first message with images: the same Windows proof an agent launch's typed
 *  follow-up waits for, then only the serialized prompt writer, which never drops the images. */
export async function deliverStartupImagePrompt(
  runtime: TerminalPromptRuntime,
  host: WorktreeStartupReadinessHost,
  handle: string,
  { agent, prompt }: WorktreeStartupFollowup,
  { signal, terminalCreation, images, onInputWritten }: StartupImagePromptOptions
): Promise<boolean> {
  try {
    const ptyId = host.getPtyId(handle)
    if (
      ptyId &&
      runtime.launchedAgentHostProvesAgent?.(ptyId) === false &&
      !(await waitForWorktreeStartupFollowup(
        host,
        handle,
        TUI_AGENT_CONFIG[agent].expectedProcess,
        signal
      ))
    ) {
      console.warn('[agent-startup] agent did not come to the front; its prompt was not delivered')
      return false
    }
    return await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent,
      freshLaunch: true,
      terminalCreation,
      text: prompt,
      ...(images ? { images } : {}),
      ...(onInputWritten ? { onInputWritten } : {}),
      unprovableHost: 'write-if-shell-provable',
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    console.warn('[agent-startup] failed to deliver the startup prompt:', error)
    return false
  }
}
