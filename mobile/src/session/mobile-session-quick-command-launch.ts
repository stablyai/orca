import { buildMobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import { triggerError } from '../platform/haptics'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'

/** Runs a saved quick command through the session's ordinary terminal creator. */
export function launchMobileSessionQuickCommand(
  scope: Pick<
    MobileSessionAttachmentsModel,
    | 'client'
    | 'connState'
    | 'creatingTerminalRef'
    | 'creatingBrowser'
    | 'creatingMarkdown'
    | 'showToast'
  >,
  createTerminal: (
    agent?: MobileNewTabAgentOption['agent'],
    options?: MobileQuickCommandLaunch['options'] & { errorToast?: string }
  ) => Promise<unknown>,
  command: TerminalQuickCommand
): boolean {
  if (
    !scope.client ||
    scope.connState !== 'connected' ||
    scope.creatingTerminalRef.current ||
    scope.creatingBrowser ||
    scope.creatingMarkdown
  ) {
    return false
  }
  const launch = buildMobileQuickCommandLaunch(command)
  if (!launch) {
    triggerError()
    scope.showToast('Edit this quick command before running it', 1800)
    return false
  }
  const label = command.label.trim() || 'Quick command'
  void createTerminal(launch.agent, { ...launch.options, errorToast: `Couldn't run ${label}` })
  return true
}
