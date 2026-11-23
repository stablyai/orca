// google.*: this host's Google client, the accounts signed in on it, and which bots may use them.
// Tokens stay on this host; clients see emails and per-service states only.
import { GOOGLE_OWNER_ONLY } from '../../../bots/bot-google-access'
import { botOfToken } from '../../../bots/bot-of-caller'
import { getGoogleConnect, type GoogleConnect } from '../../../google/google-connect'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import { GOOGLE_ACCESS_LEVELS } from '../../../../shared/google/google-scopes'
import {
  botAskerKeys,
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../shared/google/google-who-can-ask-warning'
import {
  GoogleBotAccessSetParams,
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
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'

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
    accessLevels: [...GOOGLE_ACCESS_LEVELS],
    bots: runtime.bots.enabled()
      ? runtime.bots
          .list()
          .filter((bot) => bot.google === true)
          .map((bot) => ({ id: bot.id, name: bot.name }))
      : []
  }
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

// `workspace`: anyone who can run commands here could run the sign-in in a terminal anyway.
const GOOGLE_ASKERS_CHANGED =
  'Who can ask changed while you were confirming. Review it and turn Google on again.'

function sameAskers(shown: readonly string[], current: readonly string[]): boolean {
  const sortedShown = [...shown].sort()
  const sortedCurrent = [...current].sort()
  return (
    sortedShown.length === sortedCurrent.length &&
    sortedShown.every((key, index) => key === sortedCurrent[index])
  )
}

export const GOOGLE_METHODS = [
  defineMethod({
    name: 'google.status',
    permission: 'workspace',
    params: GoogleStatusParams,
    handler: async ({ check }, { runtime }): Promise<GoogleStatusView> => {
      const connect = google()
      const [accounts, clientKey] = check
        ? await Promise.all([connect.checkAccounts(), connect.checkClient()])
        : [await connect.accounts(), await connect.clientCheck()]
      return {
        ...(await statusView(runtime, connect)),
        accounts,
        defaultAccount: await connect.defaultAccount(),
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
    handler: async ({ botToken, callerLoopbackPort, account, services, access }, ctx) => {
      refuseFromBot(botToken, ctx)
      // Only a person at this host sees a browser opened here; a paired device opens its own.
      const here = ctx.caller?.kind === 'local-cli' || ctx.caller?.kind === 'desktop'
      return google().startSignIn(flowOwner(ctx), {
        ...(callerLoopbackPort !== undefined ? { callerLoopbackPort } : {}),
        ...(account ? { loginHint: account } : {}),
        ...(services ? { services } : {}),
        ...(access ? { access } : {}),
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
    handler: async ({ botToken, account }, ctx) => {
      refuseFromBot(botToken, ctx)
      return { defaultAccount: await google().setDefaultAccount(account) }
    }
  }),
  defineMethod({
    name: 'google.bot.set',
    permission: 'workspace',
    params: GoogleBotAccessSetParams,
    handler: async ({ botToken, botId, on, confirmedAskers }, ctx) => {
      refuseFromBot(botToken, ctx)
      ctx.runtime.bots.assertEnabled()
      const bot = await ctx.runtime.bots.update(botId, (current) => {
        if (on && confirmedAskers && !sameAskers(confirmedAskers, botAskerKeys(current))) {
          throw new InvalidArgumentError(GOOGLE_ASKERS_CHANGED)
        }
        return { google: on }
      })
      // Settings confirms this before turning Google on; the CLI prints it.
      const warning = on ? googleWhoCanAskWarning(bot.name, botOtherAskers(bot)) : null
      return {
        bot: { id: bot.id, name: bot.name, google: bot.google === true },
        ...(warning ? { warning } : {})
      }
    }
  })
] as const
