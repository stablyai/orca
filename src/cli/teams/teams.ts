// `orca teams …`: the Microsoft Teams sign-in kept by the Orca this CLI talks to, which bots may use
// it, and finding, reading, posting and reacting in chats and channels through it.
import type {
  TeamsAccountView,
  TeamsFindView,
  TeamsPlaceView,
  TeamsPostView,
  TeamsReadView,
  TeamsSignInStatus,
  TeamsStatusView
} from '../../shared/teams/teams-connect-types'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { type AuthInterruptSource, processInterrupts } from '../accounts/auth-interrupts'
import { driveHostSignIn } from '../accounts/host-sign-in-driver'
import { findBot } from '../bots/bot'
import { caller } from '../google/google'
import { readMessageText } from '../slack/slack-action-args'

const placeLine = (place: TeamsPlaceView) => `${place.label}  ${place.ref}`

export function formatTeamsAccount(account: TeamsAccountView): string[] {
  return [
    `Microsoft Teams: ${account.name}${account.email ? ` <${account.email}>` : ''} (${account.status === 'connected' ? 'connected' : 'reconnect needed'})`,
    ...(account.reason ? [`  ${account.reason}`] : []),
    `  Tenant ${account.tenantId}, app ${account.clientId}`,
    `  ${account.channels ? 'Chats and channels' : 'Chats only'}; granted: ${account.grantedScopes.join(' ') || 'none'}`
  ]
}

function formatStatus({ account, bots }: TeamsStatusView): string {
  if (!account) {
    return 'Microsoft Teams is not connected here. Connect it with `orca teams connect --tenant <id> --client <app id>`.'
  }
  return [
    ...formatTeamsAccount(account),
    bots.length > 0
      ? `Bots that may use it: ${bots.map((bot) => bot.name).join(', ')}`
      : 'No bot may use it yet; `orca teams bot <bot> --on` turns it on for one.'
  ].join('\n')
}

function formatRead({ place, messages, more }: TeamsReadView): string {
  return [
    placeLine(place),
    ...(messages.length === 0 ? ['(no messages)'] : []),
    ...messages.flatMap((message) => [
      '',
      `${message.from} · ${message.at}  ${message.ref}`,
      ...message.text.split('\n').map((line) => `  ${line}`)
    ]),
    ...(more ? ['', 'More messages remain; pass a larger --limit (at most 50) to read them.'] : [])
  ].join('\n')
}

export async function runTeamsConnect(
  ctx: HandlerContext,
  interrupts: AuthInterruptSource = processInterrupts
): Promise<void> {
  const started = await ctx.client.call<TeamsSignInStatus>('teams.signIn.start', {
    ...caller(),
    tenantId: getRequiredStringFlag(ctx.flags, 'tenant'),
    clientId: getRequiredStringFlag(ctx.flags, 'client'),
    ...(ctx.flags.get('chats-only') === true ? { chatsOnly: true } : {})
  })
  const done = await driveHostSignIn(ctx, {
    flow: started.result,
    methods: { wait: 'teams.signIn.wait', cancel: 'teams.signIn.cancel' },
    interrupts,
    accepts: (waiting) => waiting.prompt !== undefined,
    onWaiting: async ({ prompt }) => {
      if (prompt) {
        process.stderr.write(
          [
            'On any device, open this page and enter the code to sign in to Microsoft:',
            '',
            `  ${prompt.verificationUri}`,
            `  Code: ${prompt.userCode}`,
            '',
            'Waiting… (Ctrl+C to cancel)',
            ''
          ].join('\n')
        )
      }
    },
    interrupted: {
      finished:
        'Interrupted, but Teams had already connected. See it with `orca teams status`; `orca teams disconnect` undoes it.',
      unconfirmed:
        "Interrupted, and Orca didn't confirm the sign-in stopped. Run `orca teams status` to check."
    }
  })
  if (done.phase !== 'signedIn' || !done.account) {
    throw new RuntimeClientError(
      'sign_in_failed',
      done.error ?? (done.phase === 'cancelled' ? 'The sign-in was cancelled.' : 'Sign-in failed.')
    )
  }
  printResult({ ...started, result: done.account }, ctx.json, (account) =>
    [`Connected.`, ...formatTeamsAccount(account)].join('\n')
  )
}

export const TEAMS_HANDLERS: Record<string, CommandHandler> = {
  'teams status': async (ctx) => {
    const status = await ctx.client.call<TeamsStatusView>('teams.status', caller())
    printResult(status, ctx.json, formatStatus)
  },
  'teams connect': (ctx) => runTeamsConnect(ctx),
  'teams disconnect': async (ctx) => {
    const result = await ctx.client.call<{ removed: string | null }>('teams.disconnect', caller())
    printResult(result, ctx.json, ({ removed }) =>
      removed
        ? `Removed ${removed}'s Microsoft Teams sign-in from this Orca. To cancel it at Microsoft too, remove the app at https://myapps.microsoft.com.`
        : 'Microsoft Teams was not connected here.'
    )
  },
  'teams bot': async (ctx) => {
    const on = ctx.flags.get('on') === true
    if (on === (ctx.flags.get('off') === true)) {
      throw new RuntimeClientError('invalid_argument', 'Pass one of --on or --off.')
    }
    const bot = await findBot(ctx.client, getRequiredStringFlag(ctx.flags, 'bot'))
    const result = await ctx.client.call<{
      bot: { name: string; teams: boolean }
      warning?: string
    }>('teams.bot.set', { ...caller(), botId: bot.id, on })
    printResult(result, ctx.json, ({ bot: saved, warning }) =>
      saved.teams
        ? [
            `${saved.name} may now use Microsoft Teams as you, for whoever can ask it and its automations.`,
            ...(warning ? [`Note: ${warning} Change that in its Who can ask.`] : [])
          ].join('\n')
        : `${saved.name} can no longer use Microsoft Teams.`
    )
  },
  'teams find': async (ctx) => {
    const limit = getOptionalPositiveIntegerFlag(ctx.flags, 'limit')
    const result = await ctx.client.call<TeamsFindView>('teams.find', {
      ...caller(),
      query: getRequiredStringFlag(ctx.flags, 'query'),
      ...(limit ? { limit } : {})
    })
    printResult(result, ctx.json, ({ matches, note }) =>
      [
        ...(matches.length === 0 ? ['Nothing matched.'] : matches.map(placeLine)),
        ...(note ? [note] : [])
      ].join('\n')
    )
  },
  'teams read': async (ctx) => {
    const limit = getOptionalPositiveIntegerFlag(ctx.flags, 'limit')
    const result = await ctx.client.call<TeamsReadView>('teams.read', {
      ...caller(),
      ref: getRequiredStringFlag(ctx.flags, 'ref'),
      ...(limit ? { limit } : {})
    })
    printResult(result, ctx.json, formatRead)
  },
  'teams post': async (ctx) => {
    const text = await readMessageText(ctx.flags, ctx.cwd, true)
    const result = await ctx.client.call<TeamsPostView>('teams.post', {
      ...caller(),
      ref: getRequiredStringFlag(ctx.flags, 'ref'),
      text
    })
    printResult(result, ctx.json, ({ ref, webUrl }) =>
      [`Posted. ${ref}`, ...(webUrl ? [webUrl] : [])].join('\n')
    )
  },
  'teams react': async (ctx) => {
    const result = await ctx.client.call<{ ref: string; reaction: string }>('teams.react', {
      ...caller(),
      ref: getRequiredStringFlag(ctx.flags, 'ref'),
      emoji: getRequiredStringFlag(ctx.flags, 'emoji')
    })
    printResult(result, ctx.json, ({ ref, reaction }) => `Reacted ${reaction} to ${ref}.`)
  }
}
