import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { PreparedStartupPorts } from '../runtime-prepared-worktree-terminal-startup'
import type { OrcaRuntimeWithPreparedTerminals } from '../terminal/launch/prepared-terminal-runtime'
import { wslUserAct } from './workspace-create-activation'

/** A local create's prepared start: the agent waits in its host behind a Setup that gates it. */
export function preparedWorktreeStart(
  runtime: Pick<OrcaRuntimeWithPreparedTerminals, 'startSetupAgentTerminals'>,
  worktree: Worktree,
  args: { wslUserAct?: true },
  setup?: CreateWorktreeResult['setup'],
  defaultTabs?: CreateWorktreeResult['defaultTabs']
): NonNullable<PreparedStartupPorts['startPrepared']> {
  return (options, prompts) =>
    runtime.startSetupAgentTerminals(
      `id:${worktree.id}`,
      setup?.waitForAgentStartup ? setup : undefined,
      { ...options, ...wslUserAct(args) },
      () => {},
      worktree,
      prompts,
      defaultTabs?.tabs[0]?.color
    )
}
