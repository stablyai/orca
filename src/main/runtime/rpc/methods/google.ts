// google.*: this host's Google client, the accounts signed in on it, and which bots may use them.
// Tokens stay on this host; clients see emails and per-service states only.
import { GOOGLE_OWNER_ONLY, readGoogleRefusal } from '../../../bots/bot-google-access'
import { botOfToken } from '../../../bots/bot-of-caller'
import { getGoogleConnect, type GoogleConnect } from '../../../google/google-connect'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import {
  botAskerKeys,
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../shared/google/google-who-can-ask-warning'
import {
  GoogleBotAccessSetParams,
  GoogleBotConnectedParams,
  GoogleClientExportParams,
  GoogleClientImportParams,
  GoogleDefaultSetParams,
  GoogleDisconnectParams,
  GoogleFinishSignInParams,
  GoogleSignInFlowParams,
  GoogleSignInStartParams,
  GoogleSignInWaitParams,
  GoogleStatusParams
} from '../../../../shared/rpc-contract/google-params'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { BotFailureError } from '../../../../shared/bots/bot-failure-copy'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { isAgentRpcCaller, rpcCallerOperationKey } from '../callers/rpc-caller-identity'
import { googleCallerAccount } from '../google-caller-api'
import { readGoogleDefaultAccount } from '../../../google/google-credential-store'
import {
  botGoogleAccess,
  botGoogleAccountFilter,
  botGoogleDefault,
  type BotGoogleAccess
} from '../../../../shared/google/google-bot-accounts'
import { tellBotCardAnswer } from './bots-offer-answer'

function google(): GoogleConnect {
  const installed = getGoogleConnect()
  if (!installed) {
    throw new Error('Google is not available on this computer. Update Orca on it.')
  }
  return installed
}

function flowOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign Google in on this computer.')
  }
  return rpcCallerOperationKey(caller)
}

/** A bot's token, even an ended one, is refused; no token is the owner's terminal, Settings or phone. */
function refuseFromBot(botToken: string | undefined, context: RpcContext): void {
  if (botOfToken(context.runtime, botToken, context.pairedDeviceId).kind !== 'owner') {
    throw new InvalidArgumentError(GOOGLE_OWNER_ONLY)
  }
}

async function statusView(
  runtime: OrcaRuntimeService,
  connect: GoogleConnect
): Promise<Omit<GoogleStatusView, 'accounts'>> {
  return {
    client: await connect.client(),
    bots: runtime.bots.enabled()
      ? runtime.bots
          .list()
          .filter((bot) => bot.google === true)
          .map((bot) => ({
            id: bot.id,
            name: bot.name,
            ...(bot.googleAccounts ? { accounts: bot.googleAccounts } : {})
          }))
      : []
  }
}

/** The account a bot's calls without --account use, read once from this computer's default. */
async function botDefaultAccount(access: BotGoogleAccess): Promise<string | null> {
  const read = botGoogleDefault(access, await readGoogleDefaultAccount())
  return 'email' in read ? read.email : null
}

async function pickAccount(connect: GoogleConnect, wanted: string | undefined): Promise<string> {
  if (wanted) {
    return wanted
  }
  const accounts = await connect.accounts()
  if (accounts.length === 1 && accounts[0]) {
    return accounts[0].email
  }
  throw new InvalidArgumentError(
    accounts.length === 0
      ? 'No Google account is connected on this computer.'
      : `Name the account with --account: ${accounts.map((account) => account.email).join(', ')}.`
  )
}

/** What the bot reads when its owner's Connect card signs in an account: a fact, not an order. */
export function googleConnectedLine(account: string, defaultAccount: string | null): string {
  if (!defaultAccount) {
    return `Connected Google account ${account}.`
  }
  return account === defaultAccount
    ? `Connected Google account ${account} (now the default).`
    : `Connected Google account ${account} (the default stays ${defaultAccount}).`
}

// `workspace`: anyone who can run commands here could run the sign-in in a terminal anyway.
const GOOGLE_ASKERS_CHANGED =
  'Who can ask changed while you were confirming. Review it and turn Google on again.'

function sameKeys(shown: readonly string[], current: readonly string[]): boolean {
  const a = new Set(shown)
  const b = new Set(current)
  return a.size === b.size && [...a].every((key) => b.has(key))
}

function sameGoogleAccess(
  read: { on: boolean; accounts?: readonly string[] },
  current: Pick<Bot, 'google' | 'googleAccounts'>
): boolean {
  const before = botGoogleAccess({ google: read.on, googleAccounts: read.accounts?.slice() })
  const now = botGoogleAccess(current)
  return before.kind === 'some' && now.kind === 'some'
    ? sameKeys(before.accounts, now.accounts)
    : before.kind === now.kind
}

export const GOOGLE_METHODS = [
  defineMethod({
    name: 'google.status',
    permission: 'workspace',
    params: GoogleStatusParams,
    handler: async (
      { check, botToken },
      { runtime, pairedDeviceId }
    ): Promise<GoogleStatusView> => {
      const connect = google()
      // A bot without every account sees (and a check reads tokens of) only its own accounts, none
      // while Google is off for it, and the default its own calls use; the owner sees them all.
      const caller = botOfToken(runtime, botToken, pairedDeviceId)
      const access = caller.kind === 'bot' ? botGoogleAccess(caller.bot) : null
      const only = access ? botGoogleAccountFilter(access) : undefined
      const [accounts, clientKey] = check
        ? await Promise.all([connect.checkAccounts(only), connect.checkClient()])
        : [await connect.accounts(), await connect.clientCheck()]
      const defaultAccount =
        access && only ? await botDefaultAccount(access) : await connect.defaultAccount()
      return {
        ...(await statusView(runtime, connect)),
        accounts: only ? accounts.filter((account) => only(account.email)) : accounts,
        defaultAccount,
        ...(clientKey ? { clientKey } : {})
      }
    }
  }),
  defineMethod({
    name: 'google.client.import',
    permission: 'workspace',
    params: GoogleClientImportParams,
    handler: async ({ botToken, file }, ctx) => {
      refuseFromBot(botToken, ctx)
      return { client: await google().importClient(file) }
    }
  }),
  defineMethod({
    name: 'google.client.export',
    permission: 'workspace',
    params: GoogleClientExportParams,
    handler: async ({ botToken }, ctx) => {
      refuseFromBot(botToken, ctx)
      return { file: await google().exportClient() }
    }
  }),
  defineMethod({
    name: 'google.signIn.start',
    permission: 'workspace',
    params: GoogleSignInStartParams,
    handler: async ({ botToken, callerLoopbackPort, account, services, currentApp }, ctx) => {
      refuseFromBot(botToken, ctx)
      // Only a person at this host sees a browser opened here; a paired device opens its own.
      const here = ctx.caller?.kind === 'local-cli' || ctx.caller?.kind === 'desktop'
      return google().startSignIn(flowOwner(ctx), {
        ...(callerLoopbackPort !== undefined ? { callerLoopbackPort } : {}),
        ...(account ? { loginHint: account } : {}),
        ...(services ? { services } : {}),
        ...(currentApp ? { currentApp } : {}),
        openBrowser: here && callerLoopbackPort === undefined
      })
    }
  }),
  defineMethod({
    name: 'google.signIn.wait',
    permission: 'workspace',
    params: GoogleSignInWaitParams,
    handler: async ({ flowId, afterRevision }, ctx) =>
      google().waitSignIn(flowOwner(ctx), flowId, afterRevision, ctx.signal)
  }),
  defineMethod({
    name: 'google.finishSignIn',
    permission: 'workspace',
    params: GoogleFinishSignInParams,
    handler: async ({ flowId, address }, ctx) =>
      google().finishSignIn(flowOwner(ctx), flowId, address)
  }),
  defineMethod({
    name: 'google.signIn.cancel',
    permission: 'workspace',
    params: GoogleSignInFlowParams,
    handler: async ({ flowId }, ctx) => google().cancelSignIn(flowOwner(ctx), flowId)
  }),
  defineMethod({
    name: 'google.disconnect',
    permission: 'workspace',
    params: GoogleDisconnectParams,
    handler: async ({ botToken, account, revoke }, ctx) => {
      refuseFromBot(botToken, ctx)
      const connect = google()
      return connect.disconnect(await pickAccount(connect, account), revoke === true)
    }
  }),
  defineMethod({
    name: 'google.default.set',
    permission: 'workspace',
    params: GoogleDefaultSetParams,
    // A bot with Google on may switch the default when its owner asks; it only picks among connected accounts.
    handler: async ({ botToken, account }, ctx) => {
      const refusal = readGoogleRefusal(ctx.runtime, botToken, ctx.pairedDeviceId)
      if (refusal) {
        throw new InvalidArgumentError(refusal)
      }
      // A bot limited to some accounts may only pick among them.
      await googleCallerAccount({ botToken, account }, ctx)
      return { defaultAccount: await google().setDefaultAccount(account) }
    }
  }),
  defineMethod({
    name: 'google.bot.set',
    permission: 'workspace',
    params: GoogleBotAccessSetParams,
    handler: async (
      { botToken, botId, on, accounts, allAccounts, basedOn, confirmedAskers },
      ctx
    ) => {
      refuseFromBot(botToken, ctx)
      ctx.runtime.bots.assertEnabled()
      const bot = await ctx.runtime.bots.update(botId, (current) => {
        if (on && confirmedAskers && !sameKeys(confirmedAskers, botAskerKeys(current))) {
          throw new InvalidArgumentError(GOOGLE_ASKERS_CHANGED)
        }
        if (on && basedOn && !sameGoogleAccess(basedOn, current)) {
          throw new BotFailureError('googleAccountsChanged')
        }
        if (!on) {
          return { google: false, googleAccounts: undefined }
        }
        if (accounts) {
          return { google: true, googleAccounts: [...new Set(accounts)] }
        }
        // A plain on (phone setup, older clients) keeps a list; only allAccounts widens it.
        const keep = current.google === true && allAccounts !== true
        return { google: true, googleAccounts: keep ? current.googleAccounts : undefined }
      })
      // Settings confirms this before turning Google on; the CLI prints it.
      const warning = on ? googleWhoCanAskWarning(bot.name, botOtherAskers(bot)) : null
      return {
        bot: {
          id: bot.id,
          name: bot.name,
          google: bot.google === true,
          ...(bot.google === true && bot.googleAccounts ? { accounts: bot.googleAccounts } : {})
        },
        ...(warning ? { warning } : {})
      }
    }
  }),
  defineMethod({
    name: 'google.bot.connected',
    permission: 'workspace',
    params: GoogleBotConnectedParams,
    handler: async ({ botToken, botId, account, sessionId }, ctx) => {
      refuseFromBot(botToken, ctx)
      // The card runs in the owner's Orca; an agent's CLI never answers for it.
      if (isAgentRpcCaller(ctx.caller)) {
        throw new InvalidArgumentError(GOOGLE_OWNER_ONLY)
      }
      ctx.runtime.bots.assertEnabled()
      const connect = google()
      if (!(await connect.accounts()).some((entry) => entry.email === account)) {
        throw new InvalidArgumentError(`${account} isn't connected on this computer.`)
      }
      // Read now, not at the click: the sign-in can take minutes.
      const line = googleConnectedLine(account, await connect.defaultAccount())
      return tellBotCardAnswer(ctx.runtime, botId, sessionId, line)
    }
  })
] as const
