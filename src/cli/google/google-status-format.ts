// `orca google status` and `orca google connect`'s lines: the client, each account and its
// services, and which bots may use them.
import type { GoogleClientView } from '../../shared/google/google-client-config'
import type {
  GoogleAccountView,
  GoogleServiceReadiness,
  GoogleStatusView
} from '../../shared/google/google-connect-types'
import { GOOGLE_SERVICE_INFO } from '../../shared/google/google-scopes'
import { googleEmailKey } from '../../shared/google/google-bot-accounts'

const SERVICE_STATE: Record<GoogleServiceReadiness['state'], string> = {
  ready: 'ready',
  'needs-permission': 'needs permission: reconnect and allow it',
  'api-disabled': 'API off in your Google project',
  'blocked-by-admin': 'blocked by your company’s Google admin',
  error: 'not working'
}

function serviceLines(account: GoogleAccountView): string[] {
  return account.services.map((service) => {
    const label = GOOGLE_SERVICE_INFO[service.service].label
    const extra = service.enableUrl ?? (service.state === 'ready' ? undefined : service.detail)
    return `    ${label}: ${SERVICE_STATE[service.state]}${extra ? ` (${extra})` : ''}`
  })
}

export function formatGoogleAccount(
  account: GoogleAccountView,
  defaultAccount?: string | null
): string[] {
  const isDefault = defaultAccount
    ? googleEmailKey(account.email) === googleEmailKey(defaultAccount)
    : false
  const name = isDefault ? `${account.email} (default)` : account.email
  if (account.status === 'reconnect') {
    return [
      `  ${name}: Reconnect. ${account.reason ?? 'Google access ended.'}${account.googleError ? ` Google said: ${account.googleError}.` : ''} Run \`orca google connect --account ${account.email}\`.`
    ]
  }
  return [`  ${name}: connected`, ...serviceLines(account)]
}

export function clientLine(client: GoogleClientView | null): string {
  if (!client) {
    return 'Google client: none yet. Add your team’s Desktop app client with `orca google client import <file>`.'
  }
  const project = client.projectId ? ` in project ${client.projectId}` : ''
  return `Google client: ${client.clientId}${project}${client.source === 'team' ? ' (your team’s)' : ''}`
}

export function formatGoogleStatus(view: GoogleStatusView): string {
  const bots = view.bots.map(
    (bot) =>
      `${bot.name} (${!bot.accounts ? 'every account' : bot.accounts.length > 0 ? bot.accounts.join(', ') : 'no Google accounts chosen'})`
  )
  return [
    clientLine(view.client),
    view.accounts.length > 0
      ? 'Accounts on this computer:'
      : 'No Google account is connected on this computer.',
    ...view.accounts.flatMap((account) => formatGoogleAccount(account, view.defaultAccount)),
    bots.length > 0
      ? `Bots that may use Google: ${bots.join(', ')}`
      : 'No bot may use Google yet. Turn one on with `orca google bot <bot> --on`.'
  ].join('\n')
}
