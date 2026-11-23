// `orca google default`: the account Google commands and automation rules use when they name none.
import type { GoogleStatusView } from '../../shared/google/google-connect-types'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { caller, prepare } from './google'

export const GOOGLE_DEFAULT_HANDLERS: Record<string, CommandHandler> = {
  'google default': async (ctx) => {
    prepare(ctx, 'orca google default')
    const account = getOptionalStringFlag(ctx.flags, 'account')
    if (account) {
      const result = await ctx.client.call<{ defaultAccount: string }>('google.default.set', {
        ...caller(),
        account
      })
      printResult(
        result,
        ctx.json,
        ({ defaultAccount }) =>
          `${defaultAccount} is now the default. Commands and automation rules without --account use it.`
      )
      return
    }
    const status = await ctx.client.call<GoogleStatusView>('google.status', {})
    const defaultAccount = status.result.defaultAccount
    if (defaultAccount === undefined) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on this computer to pick a default Google account.'
      )
    }
    printResult({ ...status, result: { defaultAccount } }, ctx.json, ({ defaultAccount: email }) =>
      email
        ? `${email} is the default. Commands and automation rules without --account use it.`
        : 'No Google account is connected on this computer.'
    )
  }
}
