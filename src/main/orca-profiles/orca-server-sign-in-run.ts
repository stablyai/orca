import { hostname } from 'node:os'
import type {
  OrcaAccountMachinePlatform,
  OrcaAccountServerStatus,
  OrcaAccountSignInIntent,
  OrcaAccountSignInPrompt
} from '../../shared/orca-account-server-sign-in'
import type { CallerOwnedSignInChannel } from '../runtime/caller-owned-sign-in-contract'
import type { OrcaAccountService } from './orca-account-service'
import {
  getOrcaCloudAuthConfig,
  type OrcaCloudAuthConfig
} from './cloud-auth/profile-cloud-auth-config'
import { createOrcaCloudPkceSecrets } from './cloud-auth/profile-cloud-pkce'
import { readOrcaAccountStorage } from './orca-account-server-status'
import {
  probeOrcaServerSignIn,
  type OrcaServerSignInProbe
} from './orca-cloud-server-sign-in-probe'
import { cloudConnectLinkEpoch } from './cloud-auth/profile-cloud-connect-attempts'
import {
  closeServerSignInRequest,
  startServerSignInRequest,
  type ServerSignInMoveContext,
  type ServerSignInRequestBody
} from './orca-cloud-server-sign-in-requests'
import {
  ACCOUNT_CHANGED,
  awaitServerSignInApproval,
  type ServerSignInApprovalDeps
} from './orca-server-sign-in-approval'

const DEFAULT_SERVER_CLIENT_ID = 'orca-server'
const HOSTED_CODE_PAGE_PATH = '/v1/desktop/auth/server-sign-in/code'
// The cloud's code lives 5 minutes; a flow nobody finishes stops holding the host after 10.
const FLOW_TTL_MS = 10 * 60 * 1000

export type SignInCode = { code: string; state: string; redirectUri: string }
export type SignInResult = { account: OrcaAccountServerStatus }
// The flow's kind stays on the host; clients still see only the intent.
export type SignInProvider = OrcaAccountSignInIntent | `${OrcaAccountSignInIntent}:approve`
type SignInChannel = CallerOwnedSignInChannel<OrcaAccountSignInPrompt, SignInCode>

export type OrcaServerSignInDeps = {
  account: Pick<
    OrcaAccountService,
    'getAuthStatus' | 'signInWithCode' | 'selectOrg' | 'signOut' | 'refreshAuth'
  > &
    Partial<Pick<OrcaAccountService, 'onSignOutStarted' | 'signInContext'>>
  probe?: OrcaServerSignInProbe
  env?: NodeJS.ProcessEnv
  machineLabel?: () => string
  platform?: NodeJS.Platform
  startRequest?: typeof startServerSignInRequest
  closeRequest?: typeof closeServerSignInRequest
  approval?: ServerSignInApprovalDeps
}

/** Runs one sign-in on the host: the PKCE secrets are made and kept here, and only the exchange
 * result leaves. Paste mode waits for a relayed code; approve mode polls Orca Cloud. */
export async function runServerSignIn(
  deps: OrcaServerSignInDeps,
  provider: SignInProvider,
  channel: SignInChannel,
  publish: () => OrcaAccountServerStatus
): Promise<SignInResult> {
  // Bound before any await: a sign-out or another sign-in after this point makes this one stale.
  const epoch = cloudConnectLinkEpoch()
  const isSuperseded = (): boolean => cloudConnectLinkEpoch() !== epoch
  const configState = getOrcaCloudAuthConfig(deps.env)
  if (!configState.configured) {
    throw new Error(configState.setupMessage)
  }
  const config = configState.config
  const storage = readOrcaAccountStorage()
  if (storage.kind === 'refused') {
    throw new Error(`Orca can't save your sign-in on this server: ${storage.reason}`)
  }
  assertMayStart(deps, intentOf(provider))
  const clientId = deps.env?.ORCA_CLOUD_SERVER_CLIENT_ID?.trim() || DEFAULT_SERVER_CLIENT_ID
  const probe = deps.probe ?? probeOrcaServerSignIn
  if (!(await probe(config, clientId))) {
    throw new Error("Orca Cloud doesn't support server sign-in yet.")
  }
  const pkce = createOrcaCloudPkceSecrets()
  const authorizeOrigin = new URL(config.authorizeEndpoint).origin
  const hostedCodePageUrl = `${authorizeOrigin}${HOSTED_CODE_PAGE_PATH}`
  const binding = {
    clientId,
    scope: config.scope,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: 'S256',
    state: pkce.state,
    nonce: pkce.nonce,
    localProfileId: deps.account.getAuthStatus().activeProfileId,
    machineLabel: (deps.machineLabel ?? hostname)().slice(0, 256),
    machinePlatform: machinePlatform(deps.platform ?? process.platform)
  } satisfies ServerSignInRequestBody
  let reply: { code: string; redirectUri: string }
  if (provider.endsWith(':approve')) {
    reply = await awaitApproval(deps, config, binding, channel, isSuperseded)
  } else {
    channel.onPrompt({
      ...binding,
      authorizeEndpoint: config.authorizeEndpoint,
      authorizeOrigin,
      hostedCodePageUrl
    })
    const pasted = await withDeadline(channel.nextCode(), FLOW_TTL_MS, channel.signal)
    if (pasted.state !== pkce.state) {
      throw new Error('That code belongs to a different sign-in. Start again.')
    }
    reply = pasted
  }
  channel.signal.throwIfAborted()
  if (isSuperseded()) {
    throw new Error(ACCOUNT_CHANGED)
  }
  // The account service checks link ownership against the exchanged identity at commit, and the
  // commit refuses if the epoch moved while the code was being exchanged.
  const result = await deps.account.signInWithCode(
    config,
    {
      code: reply.code,
      codeVerifier: pkce.codeVerifier,
      nonce: pkce.nonce,
      redirectUri: reply.redirectUri,
      state: pkce.state
    },
    { signal: channel.signal, requireSealedStorage: true, expectedLinkEpoch: epoch }
  )
  if (result.status !== 'connected') {
    throw new Error(
      result.status === 'failed'
        ? describeExchangeFailure(result.error)
        : 'The sign-in was stopped. Start it again.'
    )
  }
  console.info('[orca-account] Signed in')
  return { account: publish() }
}

/** Starts an Orca Cloud sign-in request and waits for the person to approve it in a browser. */
async function awaitApproval(
  deps: OrcaServerSignInDeps,
  config: OrcaCloudAuthConfig,
  binding: ServerSignInRequestBody,
  channel: SignInChannel,
  isSuperseded: () => boolean
): Promise<{ code: string; redirectUri: string }> {
  const now = deps.approval?.now ?? Date.now
  const request = await (deps.startRequest ?? startServerSignInRequest)(
    config,
    binding,
    channel.signal,
    moveContext(deps)
  )
  // Only show a link on the Orca Cloud this host signs in to.
  if (!isOnOrigin(request.verificationUrl, new URL(config.authorizeEndpoint).origin)) {
    throw new Error('Orca Cloud sent a sign-in link for another site. Start again.')
  }
  channel.onPrompt({
    kind: 'approve-in-browser',
    verificationUrl: request.verificationUrl,
    userCode: request.userCode,
    machineLabel: binding.machineLabel,
    expiresAt: now() + request.expiresInSeconds * 1000
  })
  try {
    return await awaitServerSignInApproval({
      config,
      request,
      signal: channel.signal,
      isSuperseded,
      deps: deps.approval
    })
  } catch (error) {
    // Cancelled or replaced: the page in the browser says so instead of waiting to expire.
    if (channel.signal.aborted) {
      void (deps.closeRequest ?? closeServerSignInRequest)(config, request)
    }
    throw error
  }
}

/** For the approval page: the account this host was on, and who its bots' links belong to. */
function moveContext(deps: OrcaServerSignInDeps): ServerSignInMoveContext | undefined {
  const context = deps.account.signInContext?.()
  if (!context?.previous && !context?.links) {
    return undefined
  }
  return {
    ...(context.previous
      ? { previousUserId: context.previous.userId, previousEmail: context.previous.email }
      : {}),
    ...(context.links
      ? {
          linkOwnerUserIds: context.links.ownerUserIds.slice(0, MOVE_CONTEXT_MAX_OWNERS),
          linkedBotNames: context.links.botNames.slice(0, MOVE_CONTEXT_MAX_BOT_NAMES)
        }
      : {})
  }
}

// Orca Cloud's limits on these fields; the page names five bots at most.
const MOVE_CONTEXT_MAX_OWNERS = 8
const MOVE_CONTEXT_MAX_BOT_NAMES = 5

function assertMayStart(deps: OrcaServerSignInDeps, intent: OrcaAccountSignInIntent): void {
  if (intent === 'sign-in' && deps.account.getAuthStatus().state === 'connected') {
    throw new Error('This server is already signed in. Use Switch account to change it.')
  }
}

export function intentOf(provider: SignInProvider): OrcaAccountSignInIntent {
  return provider.startsWith('switch-account') ? 'switch-account' : 'sign-in'
}

function isOnOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

function describeExchangeFailure(error: string): string {
  // The cloud spends the code on first use and expires it after five minutes.
  return /^orca_cloud_request_failed_4\d\d$/.test(error)
    ? "Orca Cloud didn't accept that code. It may have expired or already been used. Start again."
    : error
}

function machinePlatform(platform: NodeJS.Platform): OrcaAccountMachinePlatform {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
}

function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('This sign-in expired. Start it again.')), ms)
    timer.unref?.()
    const settle = (): void => clearTimeout(timer)
    signal.addEventListener('abort', settle, { once: true })
    promise.then(
      (value) => {
        settle()
        resolve(value)
      },
      (error: unknown) => {
        settle()
        reject(error)
      }
    )
  })
}
