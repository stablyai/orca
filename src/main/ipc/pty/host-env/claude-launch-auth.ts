// Hold credential ownership until the caller commits a child or abandons its spawn.
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { ClaudeAccountSelectionTarget } from '../../../claude-accounts/runtime-selection'
import { assertClaudeProfileEnvironment } from '../../../claude-accounts/claude-profile-environment'
import { pinClaudeProfileTerminalCommand } from '../../../claude-accounts/claude-profile-cli'
import { reserveClaudeCredentialOwner } from '../../../claude-accounts/live-pty-gate'
import type { PrepareClaudeAuth } from './types'

export async function prepareClaudeTerminalAuth(input: {
  isClaudeLaunch: boolean
  reattach: boolean
  command?: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumesConversation: boolean
  migrationAt?: number
  target: ClaudeAccountSelectionTarget
  prepare?: PrepareClaudeAuth
}) {
  if (input.reattach) {
    return { auth: null, command: input.command, release: undefined }
  }
  const accountId = input.launchConfig?.claudeAccountId
  if (accountId && (!input.isClaudeLaunch || !input.prepare)) {
    throw new Error('The saved Claude account requires a local Claude launch.')
  }
  if (!input.isClaudeLaunch) {
    return { auth: null, command: input.command, release: undefined }
  }
  if (
    input.migrationAt &&
    input.resumesConversation &&
    input.launchConfig?.claudeAccountId === undefined
  ) {
    throw new Error(
      'This saved Claude conversation predates account isolation and has no verified account binding. Open its history with the original account before resuming.'
    )
  }
  const release = reserveClaudeCredentialOwner(Boolean(accountId))
  try {
    if (accountId) {
      assertClaudeProfileEnvironment(input.env)
    }
    const pinnedCommand = accountId
      ? await pinClaudeProfileTerminalCommand(input.command, input.env)
      : input.command
    const auth =
      (await input.prepare?.(input.target, accountId ? { accountId } : undefined)) ?? null
    if (auth?.isolatedCredentials) {
      assertClaudeProfileEnvironment(input.env)
    }
    const command =
      auth?.isolatedCredentials && !accountId
        ? await pinClaudeProfileTerminalCommand(input.command, input.env)
        : pinnedCommand
    return { auth, command, release }
  } catch (error) {
    release()
    throw error
  }
}
