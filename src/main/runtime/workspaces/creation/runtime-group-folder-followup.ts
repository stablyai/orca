import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { WorktreeStartupFollowup } from '../startup/runtime-worktree-agent-startup'
import type { WorktreeStartupReadinessHost } from '../startup/runtime-worktree-startup-readiness'
import {
  deliverTerminalAgentLaunchPrompt,
  waitForStartedAgentReady,
  type TerminalPromptRuntime
} from '../../rpc/methods/agent-launch/agent-launch-terminal-prompt'

export async function deliverGroupFolderStartupFollowup({
  runtime,
  host,
  terminal,
  followup,
  beforeWrite
}: {
  runtime: TerminalPromptRuntime
  host: WorktreeStartupReadinessHost
  terminal: RuntimeTerminalCreate
  followup: WorktreeStartupFollowup
  beforeWrite: (ptyId: string) => void
}): Promise<boolean> {
  try {
    const ptyId = host.getPtyId(terminal.handle)
    if (!ptyId) {
      return false
    }
    if (
      runtime.launchedAgentHostProvesAgent?.(ptyId) === false &&
      runtime.launchedAgentHostProvesShellAlone?.(ptyId) !== true
    ) {
      const ready = await waitForStartedAgentReady(
        runtime,
        terminal.handle,
        followup.agent,
        undefined,
        terminal
      )
      if (!ready?.satisfied) {
        return false
      }
      beforeWrite(ptyId)
      host.write(ptyId, `${followup.prompt}\r`, 'launch')
      return true
    }
    return await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle: terminal.handle,
      agent: followup.agent,
      freshLaunch: true,
      terminalCreation: terminal,
      text: followup.prompt,
      unprovableHost: 'write-if-shell-provable',
      beforeWrite
    })
  } catch (error) {
    console.warn('[worktree-create] failed to deliver the group startup prompt:', error)
    return false
  }
}
