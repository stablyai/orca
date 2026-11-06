import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import type { ClaudeAuthProxyStatus } from '../../shared/claude-auth-proxy-status'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'

/**
 * `orca account auth-proxy --agent claude --on|--off|--status`: writes the host setting
 * behind Settings › Accounts › Claude › "Bill Claude through a local auth proxy", or
 * prints the live listener.
 *
 * Why no remote-flag rejection: the proxy runs on the runtime it is written on, so
 * `--environment <server>` is the one way to set it for a headless Orca server.
 */
export async function setClaudeAuthProxy(ctx: HandlerContext): Promise<void> {
  const agent = ctx.flags.get('agent') ?? 'claude'
  if (agent !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Only --agent claude supports auth-proxy today.'
    )
  }
  const on = ctx.flags.get('on') === true
  const off = ctx.flags.get('off') === true
  const status = ctx.flags.get('status') === true
  if (Number(on) + Number(off) + Number(status) !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --on, --off, or --status.'
    )
  }
  if (status) {
    const result = await ctx.client.call<ClaudeAuthProxyStatus>(
      'accounts.claudeAuthProxyStatus',
      {}
    )
    printClaudeAuthProxyStatus(result.result, ctx.json)
    return
  }
  const result = await ctx.client.call<ClaudeRateLimitAccountsState>(
    'accounts.setClaudeAuthProxy',
    {
      enabled: on
    }
  )
  const enabled = result.result.authProxy ?? (on ? 'on' : 'off')
  if (ctx.json) {
    console.log(JSON.stringify({ authProxy: enabled }, null, 2))
    return
  }
  console.log(`Claude auth-proxy: ${enabled}`)
}

function printClaudeAuthProxyStatus(status: ClaudeAuthProxyStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  const lines = [
    status.listening && status.port !== null
      ? `Claude auth-proxy: ${formatProxyEndpoint(status.host, status.port)}`
      : 'Claude auth-proxy: not listening'
  ]
  if (status.slots.length === 0) {
    lines.push('  slots: none')
  } else {
    for (const slot of status.slots) {
      lines.push(`  ${slot.slot} → ${slot.accountId}`)
    }
  }
  if (status.requestsLastHour.length === 0) {
    lines.push('  requests last hour: none')
  } else {
    for (const row of status.requestsLastHour) {
      lines.push(`  requests last hour: ${row.accountId} ${row.count}`)
    }
  }
  lines.push(`  unknown slots: ${status.unknownSlotRequests}`)
  lines.push(
    status.lastError
      ? `  last error: ${status.lastError.status} ${status.lastError.method} ${status.lastError.path} ${status.lastError.accountId ?? '-'}`
      : '  last error: none'
  )
  console.log(lines.join('\n'))
}

function formatProxyEndpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}
