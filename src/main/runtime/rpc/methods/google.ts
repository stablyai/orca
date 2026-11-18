// google.*: this host's Google client, the accounts signed in on it, and which bots may use them.
// Tokens stay on this host; clients see emails and per-service states only.
import { GOOGLE_OWNER_ONLY } from '../../../bots/bot-google-access'
import { botOfCaller } from '../../../bots/bot-of-caller'
import { getGoogleConnect, type GoogleConnect } from '../../../google/google-connect'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import {
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../shared/google/google-who-can-ask-warning'
import {
  GoogleBotAccessSetParams,
  GoogleClientExportParams,
  GoogleClientImportParams,
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

function refuseFromBot(callerSessionId: string | undefined, context: RpcContext): void {
  if (botOfCaller(context.runtime, callerSessionId, context.pairedDeviceId)) {
    throw new InvalidArgumentError(GOOGLE_OWNER_ONLY)
  }
}

function statusView(
  runtime: OrcaRuntimeService,
  connect: GoogleConnect
): Omit<GoogleStatusView, 'accounts'> {
  return {
    client: connect.client(),
    bots: runtime.bots.enabled()
      ? runtime.bots
          .list()
          .filter((bot) => bot.google === true)
          .map((bot) => ({ id: bot.id, name: bot.name }))
      : []
  }
}

function pickAccount(connect: GoogleConnect, wanted: string | undefined): string {
  if (wanted) {
    return wanted
  }
  const accounts = connect.accounts()
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
export const GOOGLE_METHODS = [
  defineMethod({
    name: 'google.status',
    permission: 'workspace',
    params: GoogleStatusParams,
    handler: async ({ check }, { runtime }): Promise<GoogleStatusView> => {
      const connect = google()
      const [accounts, clientKey] = check
        ? await Promise.all([connect.checkAccounts(), connect.checkClient()])
        : [connect.accounts(), connect.clientCheck()]
      return { ...statusView(runtime, connect), accounts, ...(clientKey ? { clientKey } : {}) }
    }
  }),
  defineMethod({
    name: 'google.client.import',
    permission: 'workspace',
    params: GoogleClientImportParams,
    handler: async ({ callerSessionId, file }, ctx) => {
      refuseFromBot(callerSessionId, ctx)
      return { client: google().importClient(file) }
    }
  }),
  defineMethod({
    name: 'google.client.export',
    permission: 'workspace',
    params: GoogleClientExportParams,
    handler: async ({ callerSessionId }, ctx) => {
      refuseFromBot(callerSessionId, ctx)
      return { file: google().exportClient() }
    }
  }),
  defineMethod({
    name: 'google.signIn.start',
    permission: 'workspace',
    params: GoogleSignInStartParams,
    handler: async ({ callerSessionId, callerLoopbackPort, account, services }, ctx) => {
      refuseFromBot(callerSessionId, ctx)
      // Only a person at this host sees a browser opened here; a paired device opens its own.
      const here = ctx.caller?.kind === 'local-cli' || ctx.caller?.kind === 'desktop'
      return google().startSignIn(flowOwner(ctx), {
        ...(callerLoopbackPort !== undefined ? { callerLoopbackPort } : {}),
        ...(account ? { loginHint: account } : {}),
        ...(services ? { services } : {}),
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
    handler: async ({ callerSessionId, account, revoke }, ctx) => {
      refuseFromBot(callerSessionId, ctx)
      const connect = google()
      return connect.disconnect(pickAccount(connect, account), revoke === true)
    }
  }),
  defineMethod({
    name: 'google.bot.set',
    permission: 'workspace',
    params: GoogleBotAccessSetParams,
    handler: async ({ callerSessionId, botId, on }, ctx) => {
      refuseFromBot(callerSessionId, ctx)
      ctx.runtime.bots.assertEnabled()
      const bot = await ctx.runtime.bots.update(botId, { google: on })
      // Settings confirms this before turning Google on; the CLI prints it.
      const warning = on ? googleWhoCanAskWarning(bot.name, botOtherAskers(bot)) : null
      return {
        bot: { id: bot.id, name: bot.name, google: bot.google === true },
        ...(warning ? { warning } : {})
      }
    }
  })
] as const
