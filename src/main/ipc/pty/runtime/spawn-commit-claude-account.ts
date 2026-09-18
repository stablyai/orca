import {
  markClaudePtySpawned,
  type ClaudeExecutionAccountBinding
} from '../../../claude-accounts/live-pty-gate'
import type { RuntimePtySpawnState } from './spawn-state'

export function recordClaudeExecutionAccountBinding(ctx: RuntimePtySpawnState): void {
  if (ctx.isClaudeLaunch && !ctx.stablePaneOwner) {
    const binding: ClaudeExecutionAccountBinding | undefined = ctx.claudeAuth
      ? {
          accountId: ctx.claudeAuth.accountId,
          runtime: ctx.claudeAuth.runtime ?? 'host',
          wslDistro: ctx.claudeAuth.wslDistro ?? null,
          configDir: ctx.claudeAuth.configDir
        }
      : undefined
    markClaudePtySpawned(ctx.result.id, binding)
  }
}
