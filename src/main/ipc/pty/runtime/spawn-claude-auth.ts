// Runtime and desktop spawns share credential admission; runtime owns its captured resume config.
import { prepareClaudeTerminalAuth } from '../host-env/claude-launch-auth'
import { isClaudeAuthSwitchInProgress } from '../../../claude-accounts/live-pty-gate'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE,
  hasClaudeAuthEnvConflict
} from '../../../claude-accounts/environment'
import type { RuntimePtySpawnState } from './spawn-state'

export async function prepareRuntimeClaudeAuth(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  const prepared = await prepareClaudeTerminalAuth({
    ...args,
    command: ctx.launchCommand,
    isClaudeLaunch: ctx.isClaudeLaunch,
    reattach: Boolean(ctx.preAdoptedStablePane),
    resumesConversation: Boolean(args.resumeProviderSession),
    migrationAt: ctx.deps.getSettings?.()?.claudeProfileMigrationAt,
    target: ctx.codexSelectionTarget,
    prepare: ctx.deps.prepareClaudeAuth
  })
  ctx.claudeAuth = prepared.auth
  ctx.launchCommand = prepared.command
  ctx.releaseClaudeCredentialOwner = prepared.release
  if (ctx.isClaudeLaunch && !ctx.preAdoptedStablePane) {
    args.launchConfig = {
      agentArgs: '',
      agentEnv: {},
      ...args.launchConfig,
      claudeAccountId:
        ctx.claudeAuth?.accountId ?? (ctx.claudeAuth?.provenance === 'system' ? null : undefined)
    }
  }
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
  }
  if (ctx.claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
    throw new Error(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
  }
}
