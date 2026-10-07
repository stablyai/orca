import { ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/types'

function requireLocalHost(ctx: HandlerContext): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    'runtime access administration. Run directly on the Orca host.'
  )
  if (
    process.env.ORCA_CLI_CWD !== undefined ||
    process.env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV] === 'ssh'
  ) {
    throw new RuntimeClientError(
      'forbidden',
      'Run runtime-access directly in a terminal on the Orca host, not through the SSH/WSL CLI bridge.'
    )
  }
  for (const name of ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING']) {
    if (process.env[name]) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unset ${name} and run runtime-access directly on the intended Orca host.`
      )
    }
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'forbidden',
      'Runtime access administration requires a local host connection'
    )
  }
}

export const RUNTIME_ACCESS_HANDLERS: Record<string, CommandHandler> = {
  'runtime-access list': async (ctx) => {
    requireLocalHost(ctx)
    const response = await ctx.client.call<{ grants: RuntimeAccessGrant[] }>('runtimeAccess.list')
    printResult(response, ctx.json, ({ grants }) =>
      [
        `Runtime: ${response._meta.runtimeId}`,
        ...grants.map(
          (grant) =>
            `${grant.deviceId}\t${JSON.stringify(grant.name).replace(/[\u007f-\u009f]/g, (char) => `\\u00${char.charCodeAt(0).toString(16)}`)}\t${grant.lastSeenAt === null ? 'pending' : new Date(grant.lastSeenAt).toISOString()}`
        )
      ].join('\n')
    )
  },
  'runtime-access revoke': async (ctx) => {
    requireLocalHost(ctx)
    const deviceId = getRequiredStringFlag(ctx.flags, 'device')
    const response = await ctx.client.call<{ revoked: boolean }>('runtimeAccess.revoke', {
      deviceId
    })
    printResult(
      response,
      ctx.json,
      () => `Runtime: ${response._meta.runtimeId}\nRevoked runtime access grant ${deviceId}.`
    )
  }
}
