// `orca google …`: the Google client and accounts kept by the Orca on this computer, and which bots
// may use them. The host runs the sign-in; this command shows its link and relays a pasted address.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { GoogleClientView } from '../../shared/google/google-client-config'
import type {
  GoogleAccountView,
  GoogleServiceReadiness,
  GoogleSignInStatus,
  GoogleStatusView
} from '../../shared/google/google-connect-types'
import {
  GOOGLE_SERVICE_CHOICES,
  GOOGLE_SERVICE_INFO,
  type GoogleServiceChoice
} from '../../shared/google/google-scopes'
import {
  readInjectedAgentSessionId,
  readInjectedBotToken
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalStringFlag,
  getOptionalStringFlagAllowingEmpty,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/connection/types'
import { type AuthInterruptSource, processInterrupts } from '../accounts/auth-interrupts'
import { findBot } from '../bots/bot'
import { driveHostSignIn } from '../accounts/host-sign-in-driver'

const SERVICE_STATE: Record<GoogleServiceReadiness['state'], string> = {
  ready: 'ready',
  'needs-permission': 'needs permission: reconnect and allow it',
  'api-disabled': 'API off in your Google project',
  'blocked-by-admin': 'blocked by your company’s Google admin',
  error: 'not working'
}

export function prepare(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it in a terminal on the computer whose Google you are setting up.`
  )
}

/** A bot run's token, which the host refuses owner-only changes from, and the chat it runs from. */
export const caller = () => {
  const botToken = readInjectedBotToken()
  const callerSessionId = readInjectedAgentSessionId()
  return { ...(botToken ? { botToken } : {}), ...(callerSessionId ? { callerSessionId } : {}) }
}

function serviceLines(account: GoogleAccountView): string[] {
  return account.services.map((service) => {
    const label = GOOGLE_SERVICE_INFO[service.service].label
    const extra = service.enableUrl ?? (service.state === 'ready' ? undefined : service.detail)
    return `    ${label}: ${SERVICE_STATE[service.state]}${extra ? ` (${extra})` : ''}`
  })
}

export function formatGoogleAccount(account: GoogleAccountView, isDefault = false): string[] {
  const name = isDefault ? `${account.email} (default)` : account.email
  if (account.status === 'reconnect') {
    return [
      `  ${name}: Reconnect. ${account.reason ?? 'Google access ended.'} Run \`orca google connect --account ${account.email}\`.`
    ]
  }
  return [`  ${name}: connected`, ...serviceLines(account)]
}

function clientLine(client: GoogleClientView | null): string {
  if (!client) {
    return 'Google client: none yet. Add your team’s Desktop app client with `orca google client import <file>`.'
  }
  const project = client.projectId ? ` in project ${client.projectId}` : ''
  return `Google client: ${client.clientId}${project}${client.source === 'team' ? ' (your team’s)' : ''}`
}

export function formatGoogleStatus(view: GoogleStatusView): string {
  const bots = view.bots.map(
    (bot) =>
      `${bot.name} (${!bot.accounts ? 'every account' : bot.accounts.length > 0 ? bot.accounts.join(', ') : 'no account chosen'})`
  )
  return [
    clientLine(view.client),
    view.accounts.length > 0
      ? 'Accounts on this computer:'
      : 'No Google account is connected on this computer.',
    ...view.accounts.flatMap((account) =>
      formatGoogleAccount(account, account.email === view.defaultAccount)
    ),
    bots.length > 0
      ? `Bots that may use Google: ${bots.join(', ')}`
      : 'No bot may use Google yet. Turn one on with `orca google bot <bot> --on`.'
  ].join('\n')
}

/** `--services gmail,calendar,files`, each once; undefined when not given. */
export function readServices(value: string | undefined): GoogleServiceChoice[] | undefined {
  if (value === undefined) {
    return undefined
  }
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  const unknown = names.filter((name) => !GOOGLE_SERVICE_CHOICES.some((choice) => choice === name))
  if (names.length === 0 || unknown.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--services takes ${GOOGLE_SERVICE_CHOICES.join(', ')} (comma-separated)${unknown.length > 0 ? `, not ${unknown.join(', ')}` : ''}.`
    )
  }
  return GOOGLE_SERVICE_CHOICES.filter((choice) => names.includes(choice))
}

/** `--accounts a@x.com,b@y.com`, each once and lowercased; undefined when not given. */
export function readAccounts(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  const emails = [...new Set(value.split(',').map((email) => email.trim().toLowerCase()))]
  const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+$/.test(email))
  if (invalid.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--accounts takes Google account emails, comma-separated, not ${invalid.join(', ') || 'an empty one'}. \`orca google status\` lists the accounts here.`
    )
  }
  return emails
}

/** Relays each pasted line until one is taken; a refused paste prints why and keeps listening. */
function relayPastes(
  ctx: HandlerContext,
  flowId: string,
  input: NodeJS.ReadableStream
): () => void {
  if (!input.readable) {
    return () => {}
  }
  const lines = createInterface({ input, terminal: false })
  let sent = false
  lines.on('line', (line) => {
    const callbackUrl = line.trim()
    if (sent || !callbackUrl) {
      return
    }
    void ctx.client
      .call<GoogleSignInStatus>('google.finishSignIn', { flowId, address: callbackUrl })
      .then(() => {
        sent = true
        process.stderr.write('Got it. Finishing…\n')
      })
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
  })
  return () => lines.close()
}

export async function runGoogleConnect(
  ctx: HandlerContext,
  interrupts: AuthInterruptSource = processInterrupts,
  input: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  prepare(ctx, 'orca google connect')
  const account = getOptionalStringFlag(ctx.flags, 'account')
  const services = readServices(getOptionalStringFlag(ctx.flags, 'services'))
  const started = await ctx.client.call<GoogleSignInStatus>('google.signIn.start', {
    ...caller(),
    ...(account ? { account } : {}),
    ...(services ? { services } : {})
  })
  const done = await driveHostSignIn(ctx, {
    flow: started.result,
    methods: { wait: 'google.signIn.wait', cancel: 'google.signIn.cancel' },
    interrupts,
    accepts: (waiting) => waiting.prompt !== undefined,
    onWaiting: async ({ prompt, flowId }) => {
      if (!prompt) {
        return
      }
      process.stderr.write(
        [
          prompt.browserOpened
            ? 'Finish connecting Google in your browser. If it did not open, use this link:'
            : 'Open this link in a browser on any device and sign in to Google:',
          '',
          `  ${prompt.authorizeUrl}`,
          '',
          "If the browser then ends on a page that can't load, copy that page's address and paste it here.",
          'Waiting… (Ctrl+C to cancel)',
          ''
        ].join('\n')
      )
      return relayPastes(ctx, flowId, input)
    },
    interrupted: {
      finished:
        'Interrupted, but Google had already connected. See it with `orca google status`; `orca google disconnect` undoes it.',
      unconfirmed:
        "Interrupted, and this computer didn't confirm the sign-in stopped. Run `orca google status` to check."
    }
  })
  if (done.phase !== 'signedIn' || !done.account) {
    throw new RuntimeClientError(
      'sign_in_failed',
      done.error ??
        (done.phase === 'cancelled'
          ? 'The sign-in was cancelled.'
          : done.phase === 'failed'
            ? 'Sign-in failed.'
            : 'The sign-in did not start.')
    )
  }
  printResult({ ...started, result: done.account }, ctx.json, (connected) =>
    [`Connected Google as ${connected.email}.`, ...formatGoogleAccount(connected).slice(1)].join(
      '\n'
    )
  )
}

export const GOOGLE_HANDLERS: Record<string, CommandHandler> = {
  'google status': async (ctx) => {
    prepare(ctx, 'orca google status')
    const status = await ctx.client.call<GoogleStatusView>('google.status', {
      ...caller(),
      ...(ctx.flags.get('check') === true ? { check: true } : {})
    })
    printResult(status, ctx.json, formatGoogleStatus)
  },
  'google client import': async (ctx) => {
    prepare(ctx, 'orca google client import')
    const path = resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'file'))
    let file: string
    try {
      file = readFileSync(path, 'utf-8')
    } catch {
      throw new RuntimeClientError('invalid_argument', `Can't read ${path}.`)
    }
    const result = await ctx.client.call<{ client: GoogleClientView }>('google.client.import', {
      ...caller(),
      file
    })
    printResult(result, ctx.json, ({ client }) =>
      [`Saved. ${clientLine(client)}`, 'Next: `orca google connect`.'].join('\n')
    )
  },
  'google client export': async (ctx) => {
    prepare(ctx, 'orca google client export')
    const path = resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'out'))
    const result = await ctx.client.call<{ file: string }>('google.client.export', caller())
    writeFileSync(path, result.result.file, { mode: 0o600 })
    printResult(
      { ...result, result: { path } },
      ctx.json,
      ({ path: saved }) =>
        `Saved to ${saved}. A teammate adds it with \`orca google client import ${saved}\`.`
    )
  },
  'google connect': (ctx) => runGoogleConnect(ctx),
  'google disconnect': async (ctx) => {
    prepare(ctx, 'orca google disconnect')
    const account = getOptionalStringFlag(ctx.flags, 'account')
    const revoke = ctx.flags.get('revoke') === true
    const result = await ctx.client.call<{
      removed: string
      revoked: boolean | null
      defaultAccount?: string | null
    }>('google.disconnect', {
      ...caller(),
      ...(account ? { account } : {}),
      ...(revoke ? { revoke } : {})
    })
    printResult(result, ctx.json, ({ removed, revoked, defaultAccount }) =>
      [
        revoked === null
          ? `Removed ${removed} from this computer. It is still allowed at Google; add --revoke to cancel it there too.`
          : revoked
            ? `Removed ${removed} from this computer and revoked it at Google.`
            : `Removed ${removed} from this computer, but Google didn't confirm the revoke. Remove Orca at https://myaccount.google.com/permissions.`,
        ...(defaultAccount ? [`Default account: ${defaultAccount}.`] : [])
      ].join(' ')
    )
  },
  'google bot': async (ctx) => {
    prepare(ctx, 'orca google bot')
    // An empty --accounts is refused, never read as absent (which --on would make every account).
    const accounts = readAccounts(getOptionalStringFlagAllowingEmpty(ctx.flags, 'accounts'))
    const picked = [
      ctx.flags.get('on') === true,
      ctx.flags.get('off') === true,
      accounts !== undefined
    ]
    if (picked.filter(Boolean).length !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass one of --on, --off or --accounts.')
    }
    const on = ctx.flags.get('off') !== true
    const bot = await findBot(ctx.client, getRequiredStringFlag(ctx.flags, 'bot'))
    const result = await ctx.client.call<{
      bot: { name: string; google: boolean; accounts?: string[] }
      warning?: string
    }>('google.bot.set', { ...caller(), botId: bot.id, on, ...(accounts ? { accounts } : {}) })
    printResult(result, ctx.json, ({ bot: saved, warning }) =>
      saved.google
        ? [
            `${saved.name} may now use ${saved.accounts ? `Google as ${saved.accounts.join(', ')}` : 'Google as you, with every account on this computer'}, for whoever can ask it and its automations.`,
            ...(warning ? [`Note: ${warning} Change that in its Who can ask.`] : [])
          ].join('\n')
        : `${saved.name} can no longer use Google.`
    )
  }
}
