import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import {
  ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY,
  ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/orca-account-runtime-capabilities'
import {
  isOrcaAccountApprovalPrompt,
  type OrcaAccountServerStatus,
  type OrcaAccountSignInStatus
} from '../../shared/orca-account-server-sign-in'
import { type AuthInterruptSource, processInterrupts } from './auth-interrupts'
import { assertHostCapability, driveHostSignIn } from './host-sign-in-driver'

function assertHostSupportsSignIn(
  ctx: HandlerContext,
  capability: string = ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY
): Promise<void> {
  return assertHostCapability(
    ctx,
    capability,
    'The running Orca on this host is too old to sign in from the terminal. Update Orca on this host and try again.'
  )
}

function rejectRemoteFlags(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it in a terminal on the host you want to sign in.`
  )
}

function describeStorageWarning(status: OrcaAccountServerStatus): string | null {
  return status.storage.kind === 'host-key' ? `Note: ${status.storage.warning}` : null
}

function formatStatus(status: OrcaAccountServerStatus): string {
  const lines: string[] = []
  if (status.state === 'signed-in') {
    const org = status.orgName ? ` · ${status.orgName}` : ''
    lines.push(`Signed in as ${status.email ?? 'unknown'}${org}`)
    if (status.lastConfirmedAt) {
      lines.push(
        `Last confirmed by Orca Cloud: ${new Date(status.lastConfirmedAt).toLocaleString()}`
      )
    }
  } else if (status.state === 'unconfigured') {
    lines.push('Orca account sign-in is not configured for this build.')
  } else {
    lines.push(
      status.state === 'reconnect-required' ? 'Signed out: sign in again.' : 'Not signed in.'
    )
    if (status.reason) {
      lines.push(status.reason)
    }
  }
  const warning = describeStorageWarning(status)
  if (warning) {
    lines.push(warning)
  } else if (status.storage.kind === 'refused') {
    lines.push(`Orca can't save a sign-in on this host: ${status.storage.reason}`)
  }
  return lines.join('\n')
}

/** Picks an org by id or exact name, case-insensitively. */
function findOrg(status: OrcaAccountServerStatus, wanted: string): string {
  const needle = wanted.trim().toLowerCase()
  const match = status.organizations?.find(
    (org) => org.orgId.toLowerCase() === needle || org.name.toLowerCase() === needle
  )
  if (!match) {
    const names = status.organizations?.map((org) => org.name).join(', ') || 'none'
    throw new RuntimeClientError(
      'invalid_argument',
      `No organization named "${wanted}" on this account. Choose from: ${names}.`
    )
  }
  return match.orgId
}

export async function runAuthLogin(
  ctx: HandlerContext,
  interrupts: AuthInterruptSource = processInterrupts
): Promise<void> {
  rejectRemoteFlags(ctx, 'orca auth login')
  const orgFlag = ctx.flags.get('org')
  if (orgFlag === true) {
    throw new RuntimeClientError('invalid_argument', 'Missing a value for --org.')
  }
  // Hosts from before approve-in-browser would show a paste prompt this command no longer reads.
  await assertHostSupportsSignIn(ctx, ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY)
  const started = await ctx.client.call<OrcaAccountSignInStatus>('orcaAccount.signIn.start', {
    switchAccount: ctx.flags.get('switch') === true,
    approveInBrowser: true
  })
  const done = await driveHostSignIn(ctx, {
    flow: started.result,
    methods: { wait: 'orcaAccount.signIn.wait', cancel: 'orcaAccount.signIn.cancel' },
    interrupts,
    accepts: (waiting) => isOrcaAccountApprovalPrompt(waiting.prompt),
    onWaiting: async (waiting) => {
      const prompt = waiting.prompt
      if (!isOrcaAccountApprovalPrompt(prompt)) {
        return
      }
      const before = (await ctx.client.call<OrcaAccountServerStatus>('orcaAccount.status')).result
      const warning = describeStorageWarning(before)
      process.stderr.write(
        [
          `Sign in Orca on ${prompt.machineLabel}:`,
          '',
          `  ${prompt.verificationUrl}`,
          '',
          `and check that it shows this code:  ${prompt.userCode}`,
          ...(warning ? ['', warning] : []),
          '',
          'Waiting for you to approve… (Ctrl+C to cancel)',
          ''
        ].join('\n')
      )
    },
    interrupted: {
      finished:
        'Interrupted, but the sign-in had already finished: this host is signed in. Run `orca auth logout` to undo it.',
      unconfirmed:
        "Interrupted, and the host didn't confirm the sign-in stopped. Run `orca auth status` to check."
    }
  })
  if (done.phase === 'waiting' || done.phase === 'starting') {
    throw new RuntimeClientError('sign_in_failed', done.error ?? 'The sign-in did not start.')
  }
  if (done.phase !== 'signedIn' || !done.account) {
    throw new RuntimeClientError(
      'sign_in_failed',
      done.error ?? (done.phase === 'cancelled' ? 'The sign-in was cancelled.' : 'Sign-in failed.')
    )
  }
  let account = done.account
  if (typeof orgFlag === 'string') {
    account = (
      await ctx.client.call<OrcaAccountServerStatus>('orcaAccount.selectOrg', {
        orgId: findOrg(account, orgFlag)
      })
    ).result
  }
  printResult({ ...started, result: account }, ctx.json, (status) => {
    const lines = [formatStatus(status)]
    if (typeof orgFlag !== 'string' && (status.organizations?.length ?? 0) > 1) {
      lines.push(
        `This account belongs to ${status.organizations?.length} organizations. Pick one with \`orca auth login --switch --org <name>\`.`
      )
    }
    return lines.join('\n')
  })
}

export const AUTH_HANDLERS: Record<string, CommandHandler> = {
  'auth login': (ctx) => runAuthLogin(ctx),
  'auth status': async (ctx) => {
    rejectRemoteFlags(ctx, 'orca auth status')
    await assertHostSupportsSignIn(ctx)
    const status = await ctx.client.call<OrcaAccountServerStatus>('orcaAccount.status')
    printResult(status, ctx.json, formatStatus)
    if (status.result.state !== 'signed-in') {
      process.exitCode = 1
    }
  },
  'auth logout': async (ctx) => {
    rejectRemoteFlags(ctx, 'orca auth logout')
    await assertHostSupportsSignIn(ctx)
    const status = await ctx.client.call<OrcaAccountServerStatus>('orcaAccount.signOut')
    printResult(status, ctx.json, formatStatus)
  }
}
