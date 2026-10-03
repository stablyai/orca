import type { CommandHandler, HandlerContext } from '../dispatch'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import type { GrokAccountsState } from '../../shared/grok-account-types'

function requireLocalGrok(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `${command}. Run it on the Orca host whose accounts you want to manage.`
  )
  if (ctx.flags.get('agent') !== 'grok') {
    throw new RuntimeClientError('invalid_argument', 'Use --agent grok with this command.')
  }
}

export const GROK_ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account usage': async (ctx) => {
    requireLocalGrok(ctx, 'orca account usage')
    const result = await ctx.client.call<GrokAccountsState>('accounts.listGrok', {
      refreshUsage: true
    })
    printResult(result, ctx.json, (snapshot) =>
      snapshot.accounts
        .map(
          (account) =>
            `${account.email}: ${snapshot.usage[account.id]?.weekly?.usedPercent ?? snapshot.usage[account.id]?.monthly?.usedPercent ?? 'unknown'}% used`
        )
        .join('\n')
    )
  },
  'account select': async (ctx) => {
    requireLocalGrok(ctx, 'orca account select')
    const id = ctx.flags.get('account-id')
    const system = ctx.flags.get('system') === true
    if ((system && id !== undefined) || (!system && (typeof id !== 'string' || !id))) {
      throw new RuntimeClientError('invalid_argument', 'Provide --account-id <id> or --system.')
    }
    const result = await ctx.client.call<GrokAccountsState>('accounts.selectGrok', {
      accountId: system ? null : id
    })
    printResult(result, ctx.json, () => 'Grok account selected for new local sessions.')
  },
  'account import': async (ctx) => {
    requireLocalGrok(ctx, 'orca account import')
    const sourceHome = ctx.flags.get('source-home')
    if (typeof sourceHome !== 'string' || !sourceHome) {
      throw new RuntimeClientError('invalid_argument', 'Provide --source-home <folder>.')
    }
    const result = await ctx.client.call<GrokAccountsState>('accounts.addGrokFromHome', {
      sourceHome
    })
    printResult(result, ctx.json, () => 'Grok account saved in Orca.')
  }
}
