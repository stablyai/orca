import {
  ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY,
  ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/orca-account-runtime-capabilities'
import {
  isOrcaAccountApprovalPrompt,
  type OrcaAccountServerStatus,
  type OrcaAccountSignInIntent,
  type OrcaAccountSignInPrompt,
  type OrcaAccountSignInStatus
} from '../../shared/orca-account-server-sign-in'
import { CallerOwnedSignInFlows } from '../runtime/caller-owned-sign-in-flows'
import { readOrcaAccountStorage, toServerStatus } from './orca-account-server-status'
import { onOrcaCloudSessionInvalidated } from './cloud-session/profile-cloud-session-invalidation'
import {
  intentOf,
  runServerSignIn,
  type OrcaServerSignInDeps,
  type SignInCode,
  type SignInProvider,
  type SignInResult
} from './orca-server-sign-in-run'

export type { OrcaServerSignInDeps } from './orca-server-sign-in-run'

const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000
const MAX_ERROR_CHARS = 600

/** Lets a client that can run commands on this host sign its Orca account in or out.
 * The host makes and keeps the PKCE verifier; the client only relays the one-time code. */
export class OrcaServerSignIn {
  private readonly flows: CallerOwnedSignInFlows<
    SignInProvider,
    OrcaAccountSignInPrompt,
    SignInCode,
    SignInResult
  >
  private readonly listeners = new Set<(status: OrcaAccountServerStatus) => void>()
  private readonly stopInvalidation: () => void
  private dailyRefresh: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: OrcaServerSignInDeps) {
    this.flows = new CallerOwnedSignInFlows(
      (provider, channel) => runServerSignIn(this.deps, provider, channel, () => this.publish()),
      {
        acceptsPrompt: () => true,
        // An approve-in-browser flow finishes from Orca Cloud; nothing is pasted into it.
        acceptsCode: (prompt) => prompt !== undefined && !isOrcaAccountApprovalPrompt(prompt),
        describeFailure: (message) => ({
          error:
            message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
        }),
        busyMessage: 'Another device is signing this server in. Finish or cancel it there first.',
        // Newest wins: a browser page another device left open never blocks signing in from here.
        supersedes: (running, next) =>
          running.provider.endsWith(':approve') &&
          running.phase === 'waiting' &&
          next.endsWith(':approve')
      }
    )
    const stopInvalidation = onOrcaCloudSessionInvalidated(() => this.publish())
    // The desktop window signs out through the account service directly, not through signOut() here.
    const stopSignOutWatch = deps.account.onSignOutStarted?.(() => this.cancelActive())
    this.stopInvalidation = () => {
      stopInvalidation()
      stopSignOutWatch?.()
    }
  }

  status(): OrcaAccountServerStatus {
    return toServerStatus(this.deps.account.getAuthStatus(), readOrcaAccountStorage())
  }

  onChanged(listener: (status: OrcaAccountServerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  startSignIn(
    owner: string,
    intent: OrcaAccountSignInIntent,
    options: { approveInBrowser?: boolean } = {}
  ): OrcaAccountSignInStatus {
    return toWire(this.flows.start(owner, options.approveInBrowser ? `${intent}:approve` : intent))
  }

  async waitSignIn(
    owner: string,
    flowId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<OrcaAccountSignInStatus> {
    return toWire(await this.flows.wait(owner, flowId, afterRevision, signal))
  }

  completeSignIn(owner: string, flowId: string, code: SignInCode): OrcaAccountSignInStatus {
    return toWire(this.flows.submitCode(owner, flowId, code))
  }

  async cancelSignIn(owner: string, flowId: string): Promise<OrcaAccountSignInStatus> {
    return toWire(await this.flows.cancel(owner, flowId))
  }

  async selectOrg(orgId: string): Promise<OrcaAccountServerStatus> {
    const result = await this.deps.account.selectOrg(orgId)
    if (result.status === 'failed') {
      throw new Error(result.error)
    }
    if (result.status !== 'selected') {
      throw new Error('Sign this server in again to change its organization.')
    }
    return this.publish()
  }

  private cancelActive(): void {
    const pending = this.flows.activeFlow()
    if (pending) {
      void this.flows.cancel(pending.owner, pending.flowId)
    }
  }

  async signOut(): Promise<OrcaAccountServerStatus> {
    // A sign-in still waiting for its code must not land after the sign-out.
    const pending = this.flows.activeFlow()
    if (pending) {
      await this.flows.cancel(pending.owner, pending.flowId)
    }
    await this.deps.account.signOut()
    console.info('[orca-account] Signed out')
    return this.publish()
  }

  /** Keeps an idle server's 30-day sliding session alive; a busy one refreshes on demand anyway. */
  startDailyRefresh(): void {
    if (this.dailyRefresh) {
      return
    }
    this.dailyRefresh = setInterval(() => void this.refreshIfSignedIn(), DAILY_REFRESH_MS)
    this.dailyRefresh.unref?.()
  }

  async refreshIfSignedIn(): Promise<void> {
    if (this.deps.account.getAuthStatus().state !== 'connected') {
      return
    }
    const result = await this.deps.account.refreshAuth().catch(() => null)
    if (result?.status === 'reconnect-required') {
      console.info('[orca-account] Session expired; sign in again')
      this.publish()
    }
  }

  dispose(): void {
    if (this.dailyRefresh) {
      clearInterval(this.dailyRefresh)
      this.dailyRefresh = null
    }
    this.stopInvalidation()
    this.listeners.clear()
  }

  private publish(): OrcaAccountServerStatus {
    const status = this.status()
    for (const listener of this.listeners) {
      listener(status)
    }
    return status
  }
}

function toWire(
  status: Omit<OrcaAccountSignInStatus, 'provider'> & { provider: SignInProvider }
): OrcaAccountSignInStatus {
  return { ...status, provider: intentOf(status.provider) }
}

let installed: OrcaServerSignIn | null = null

/** One account per host process; the runtime advertises the capability only once installed. */
export function installOrcaServerSignIn(server: OrcaServerSignIn | null): void {
  installed?.dispose()
  installed = server
}

export function getOrcaServerSignIn(): OrcaServerSignIn | null {
  return installed
}

/** Only a host that installed its account sign-in can be signed in by a client. */
export function orcaAccountRuntimeCapabilities(): string[] {
  return installed
    ? [
        ORCA_ACCOUNT_SERVER_SIGN_IN_RUNTIME_CAPABILITY,
        ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY
      ]
    : []
}
