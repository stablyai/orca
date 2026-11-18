// This host's Google connector: the client it signs in with, the accounts signed in on it, and the
// sign-in flows a client starts here. Only the client that started a flow can see or answer it.
import { googleClientView, type GoogleClientView } from '../../shared/google/google-client-config'
import { googleClientFile, parseGoogleClientFile } from './google-client-file'
import {
  GOOGLE_CONNECT_RUNTIME_CAPABILITY,
  GOOGLE_TRIGGERS_RUNTIME_CAPABILITY,
  type GoogleAccountView,
  type GoogleClientKeyState,
  type GoogleSignInPrompt,
  type GoogleSignInStatus
} from '../../shared/google/google-connect-types'
import {
  GOOGLE_SERVICE_CHOICES,
  googleChoices,
  grantedGoogleChoices,
  type GoogleServiceChoice
} from '../../shared/google/google-scopes'
import { CallerOwnedSignInFlows } from '../runtime/caller-owned-sign-in-flows'
import { googleAccessToken, GoogleAccountUnavailableError } from './google-account-tokens'
import {
  hasGoogleAccount,
  listGoogleAccounts,
  readGoogleAccount,
  removeGoogleAccount,
  resolveGoogleClient,
  saveGoogleAccount,
  saveImportedGoogleClient,
  type GoogleAccountRecord
} from './google-credential-store'
import { checkGoogleServices } from './google-readiness'
import { googleCallbackQuery, googlePromptExpectation } from './google-sign-in-return'
import {
  runGoogleSignIn,
  type GoogleSignInDeps,
  type GoogleSignInOptions
} from './google-sign-in-run'
import { checkGoogleClientKey } from './google-client-check'
import { defaultGoogleHttp, revokeGoogleToken } from './google-token-endpoint'

// One flow per route and services, so a start asking for something else is told one is running.
type Route = `${string}:${string}`

const NO_SIGN_IN_WAITING = 'No Google sign-in is waiting on this computer. Start one in Orca.'

export function googleAccountView(record: GoogleAccountRecord): GoogleAccountView {
  return {
    email: record.email,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    services: record.services,
    ...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
    connectedAt: record.connectedAt
  }
}

export class GoogleConnect {
  private readonly flows: CallerOwnedSignInFlows<
    Route,
    GoogleSignInPrompt,
    string,
    { account: GoogleAccountView },
    GoogleSignInOptions
  >
  private readonly deps: GoogleSignInDeps
  private keyCheck: { key: string; state: GoogleClientKeyState } | null = null

  constructor(deps: Partial<GoogleSignInDeps> = {}) {
    this.deps = {
      http: deps.http ?? defaultGoogleHttp,
      now: deps.now ?? Date.now,
      client: deps.client ?? resolveGoogleClient,
      ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {})
    }
    this.flows = new CallerOwnedSignInFlows(
      async (_route, channel, options) => {
        if (!options) {
          throw new Error('The Google sign-in did not start.')
        }
        const record = await runGoogleSignIn(this.deps, options, channel)
        return { account: googleAccountView(record) }
      },
      {
        acceptsPrompt: () => true,
        acceptsCode: (prompt) => prompt !== undefined,
        // A returned address is checked against its own flow's prompt, and only its query is kept.
        readCode: (prompt, address) => {
          if (!prompt || this.deps.now() > prompt.expiresAt) {
            throw new Error(NO_SIGN_IN_WAITING)
          }
          return googleCallbackQuery(address, googlePromptExpectation(prompt))
        },
        describeFailure: (message) => ({ error: message.slice(0, 600) }),
        busyMessage:
          'A Google sign-in is already running on this computer. Finish or cancel it first.'
      }
    )
  }

  /** Asks Google whether the saved key still works; a clear answer is kept for this key. */
  async checkClient(): Promise<GoogleClientKeyState | null> {
    const client = this.deps.client()
    if (!client) {
      return null
    }
    const state = await checkGoogleClientKey(this.deps.http, client)
    if (state !== 'unknown') {
      this.keyCheck = { key: keyOf(client), state }
    }
    return state
  }

  /** The last clear check of the saved key, if it was this key. */
  clientCheck(): GoogleClientKeyState | null {
    const client = this.deps.client()
    return client && this.keyCheck?.key === keyOf(client) ? this.keyCheck.state : null
  }

  client(): GoogleClientView | null {
    const client = this.deps.client()
    return client ? googleClientView(client) : null
  }

  importClient(fileText: string): GoogleClientView {
    const parsed = parseGoogleClientFile(fileText)
    if (!parsed.ok) {
      throw new Error(parsed.message)
    }
    const { clientId, clientSecret, projectId } = parsed
    const config = {
      clientId,
      clientSecret,
      ...(projectId ? { projectId } : {}),
      source: 'imported' as const,
      savedAt: this.deps.now()
    }
    saveImportedGoogleClient(config)
    return googleClientView(config)
  }

  /** The client as a Desktop app file, for an admin to hand to teammates. */
  exportClient(): string {
    const client = this.deps.client()
    if (!client) {
      throw new Error('There is no Google client on this computer to export.')
    }
    return googleClientFile(client)
  }

  accounts(): GoogleAccountView[] {
    return listGoogleAccounts().map((entry) =>
      'record' in entry
        ? googleAccountView(entry.record)
        : {
            email: entry.email,
            status: 'reconnect',
            reason: `${entry.unreadable} Or connect it again to replace it.`,
            services: [],
            connectedAt: 0
          }
    )
  }

  /** Re-reads every connected account's services; a grant Google ended shows as Reconnect. */
  async checkAccounts(): Promise<GoogleAccountView[]> {
    const deps = { http: this.deps.http, now: this.deps.now }
    await Promise.all(
      listGoogleAccounts().map(async ({ email }) => {
        // An unreadable account is listed as Reconnect; googleAccessToken says it isn't connected.
        try {
          const accessToken = await googleAccessToken(email, deps)
          const record = readGoogleAccount(email)
          if (!record) {
            return
          }
          const services = await checkGoogleServices({
            http: this.deps.http,
            accessToken,
            grantedScopes: record.grantedScopes,
            choices: record.choices ?? grantedGoogleChoices(record.grantedScopes),
            ...(record.projectId ? { projectId: record.projectId } : {})
          })
          saveGoogleAccount({ ...record, services, checkedAt: this.deps.now() })
        } catch (error) {
          if (!(error instanceof GoogleAccountUnavailableError)) {
            throw error
          }
        }
      })
    )
    return this.accounts()
  }

  /**
   * `services` defaults to what the named account already has, else everything; a named account
   * keeps what it has, so adding a service asks Google for the union.
   */
  startSignIn(
    owner: string,
    request: Omit<GoogleSignInOptions, 'choices'> & { services?: readonly GoogleServiceChoice[] }
  ): GoogleSignInStatus {
    const { services, ...rest } = request
    const existing = rest.loginHint ? readGoogleAccount(rest.loginHint) : null
    const had = existing ? (existing.choices ?? grantedGoogleChoices(existing.grantedScopes)) : []
    const choices = googleChoices([
      ...(services ?? (had.length > 0 ? had : GOOGLE_SERVICE_CHOICES)),
      ...had
    ])
    const options: GoogleSignInOptions = { ...rest, choices }
    const back =
      options.callerLoopbackPort === undefined ? 'host' : `caller-${options.callerLoopbackPort}`
    const route: Route = `${back}:${choices.join(',')}`
    return toWire(this.flows.start(owner, route, options))
  }

  async waitSignIn(
    owner: string,
    flowId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<GoogleSignInStatus> {
    return toWire(await this.flows.wait(owner, flowId, afterRevision, signal))
  }

  /**
   * Takes the address the browser ended on, pasted or relayed by an older desktop, only for the
   * sign-in this owner started and still waits on; a wrong one is refused without spending it.
   */
  finishSignIn(owner: string, flowId: string, callbackUrl: string): GoogleSignInStatus {
    return toWire(this.flows.submitCode(owner, flowId, callbackUrl))
  }

  async cancelSignIn(owner: string, flowId: string): Promise<GoogleSignInStatus> {
    return toWire(await this.flows.cancel(owner, flowId))
  }

  /** Removes the account from this host; `revoke` also cancels the grant at Google first. */
  async disconnect(
    email: string,
    revoke: boolean
  ): Promise<{ removed: string; revoked: boolean | null }> {
    if (!hasGoogleAccount(email)) {
      throw new Error(`${email} isn't connected on this computer.`)
    }
    // An account this host can't read is still removed; there is no token here to revoke.
    const record = readGoogleAccount(email)
    let revoked: boolean | null = null
    if (revoke) {
      const token = record?.refreshToken ?? record?.accessToken
      revoked = token
        ? await revokeGoogleToken(this.deps.http, token).catch(() => false)
        : record !== null
    }
    removeGoogleAccount(email)
    return { removed: email.toLowerCase(), revoked }
  }
}

function toWire(status: {
  flowId: string
  revision: number
  phase: GoogleSignInStatus['phase']
  prompt?: GoogleSignInPrompt
  error?: string
  account?: GoogleAccountView
}): GoogleSignInStatus {
  return {
    flowId: status.flowId,
    revision: status.revision,
    phase: status.phase,
    ...(status.prompt ? { prompt: status.prompt } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.account ? { account: status.account } : {})
  }
}

/** A key is new on every import, even of the same client. */
const keyOf = (client: { clientId: string; savedAt: number }): string =>
  `${client.clientId}:${client.savedAt}`

let installed: GoogleConnect | null = null

/** One per host process; the runtime advertises google.connect only once installed. */
export function installGoogleConnect(connect: GoogleConnect | null): void {
  installed = connect
}

export function getGoogleConnect(): GoogleConnect | null {
  return installed
}

export function googleRuntimeCapabilities(): string[] {
  return installed ? [GOOGLE_CONNECT_RUNTIME_CAPABILITY, GOOGLE_TRIGGERS_RUNTIME_CAPABILITY] : []
}
