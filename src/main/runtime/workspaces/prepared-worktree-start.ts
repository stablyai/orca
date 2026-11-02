import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { PreparedStartupPorts } from '../runtime-prepared-worktree-terminal-startup'
import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { PreparedTerminalPrompts } from '../../daemon/prepared-agent-launch-protocol'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import { wslUserAct } from './workspace-create-activation'

/** The prepared-terminal layer's start, named here so earlier layers can call it. */
export type PreparedStart = (
  selector: string,
  setup: WorktreeSetupLaunch | undefined,
  startupOptions: TerminalCreateOptions,
  onAgentPublished: (terminal: RuntimeTerminalCreate) => void,
  created?: Worktree,
  prompts?: PreparedTerminalPrompts,
  color?: string
) => ReturnType<NonNullable<PreparedStartupPorts['startPrepared']>>

/** A local create's prepared start: the agent waits in its host behind a Setup that gates it. */
export function preparedWorktreeStart(
  runtime: { startSetupAgentTerminals: PreparedStart },
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
