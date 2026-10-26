// This Orca's link to the Orca Cloud connector: device-code sign-in, status and sign-out.
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  CONNECTOR_PATHS,
  ConnectorSignInPollResponse,
  ConnectorSignInStartResponse
} from '../../shared/connector-cloud-contract'
import { requestConnector } from './connector-cloud-request'
import {
  connectorHostId,
  deleteConnectorHostIdentity,
  keypairFromSecret,
  readConnectorHostIdentity,
  writeConnectorHostIdentity,
  type ConnectorHostLink
} from './connector-host-identity'
import { ConnectorHostSession } from './connector-host-session'
import type { E2EEKeypair } from '../runtime/e2ee-keypair'

// Sign-out still succeeds offline: once the key is gone nobody can act as this machine.
const SIGN_OUT_UNBIND_TIMEOUT_MS = 5_000

export type ConnectorHostRuntime = 'serve' | 'desktop'

export type ConnectorCloudStatus = {
  enabled: boolean
  link: ConnectorHostLink | null
}

export type ConnectorSignInPrompt = {
  flowId: string
  userCode: string
  verificationUri: string
  expiresAt: number
}

type StartedSignIn = {
  keypair: E2EEKeypair
  hostName: string
  deviceCode: string
  expiresAt: number
  intervalMs: number
  prompt: Omit<ConnectorSignInPrompt, 'flowId'>
}

/** One sign-in from its start request to the key write; aborting `ended` retires every step. */
type SignInFlow = { id: string; ended: AbortController; started: Promise<StartedSignIn> }

const CANCELLED = 'Sign-in was cancelled.'

export type ConnectorCloudOptions = {
  userDataPath: string
  origin: string
  runtime: ConnectorHostRuntime
  orcaVersion: string
  connectorsEnabled: () => boolean
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
}

export class ConnectorCloud {
  private flow: SignInFlow | null = null
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number

  constructor(private readonly options: ConnectorCloudOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  status(): ConnectorCloudStatus {
    return {
      enabled: this.options.connectorsEnabled(),
      link: readConnectorHostIdentity(this.options.userDataPath)?.link ?? null
    }
  }

  /** Starts a sign-in the person approves in a browser by typing the code; a newer one replaces it. */
  async beginSignIn(name?: string): Promise<ConnectorSignInPrompt> {
    this.requireSignInAllowed()
    this.flow?.ended.abort()
    const ended = new AbortController()
    const flow: SignInFlow = {
      id: randomUUID(),
      ended,
      started: this.startSignIn(name?.trim() || hostname(), ended.signal)
    }
    this.flow = flow
    try {
      const { prompt } = await flow.started
      return { flowId: flow.id, ...prompt }
    } catch (error) {
      this.endFlow(flow)
      throw error
    }
  }

  /** Waits for the browser approval; the caller going away, a newer sign-in or a logout cancels it. */
  async finishSignIn(flowId: string, signal?: AbortSignal): Promise<ConnectorHostLink> {
    const flow = this.flow
    if (flow?.id !== flowId) {
      throw new Error('This sign-in is no longer running. Run `orca cloud login` again.')
    }
    const ended = signal ? AbortSignal.any([flow.ended.signal, signal]) : flow.ended.signal
    try {
      return await this.pollSignIn(await flow.started, ended)
    } finally {
      this.endFlow(flow)
    }
  }

  private requireSignInAllowed(): void {
    if (!this.options.connectorsEnabled()) {
      throw new Error('connectors_disabled')
    }
    const linked = readConnectorHostIdentity(this.options.userDataPath)?.link
    if (linked) {
      throw new Error(
        `Already connected as ${linked.email} on ${linked.hostName}. Run \`orca cloud logout\` first.`
      )
    }
  }

  private requireCurrent(flow: StartedSignIn, ended: AbortSignal): void {
    if (ended.aborted) {
      throw new Error(CANCELLED)
    }
    this.requireSignInAllowed()
    if (this.now() >= flow.expiresAt) {
      throw new Error('Sign-in expired. Run `orca cloud login` again.')
    }
  }

  private endFlow(flow: SignInFlow): void {
    flow.ended.abort()
    if (this.flow === flow) {
      this.flow = null
    }
  }

  private async startSignIn(hostName: string, ended: AbortSignal): Promise<StartedSignIn> {
    // Every sign-in links a fresh key, so a key is never moved between accounts.
    const keypair = keypairFromSecret(nacl.box.keyPair().secretKey)
    const started = await requestConnector(
      {
        fetchImpl: this.fetchImpl,
        url: `${this.options.origin}${CONNECTOR_PATHS.signInStart}`,
        body: {
          v: 1,
          hostPublicKeyB64: keypair.publicKeyB64,
          hostName,
          platform: process.platform,
          runtime: this.options.runtime,
          orcaVersion: this.options.orcaVersion
        },
        signal: ended
      },
      ConnectorSignInStartResponse
    )
    if (ended.aborted) {
      throw new Error(CANCELLED)
    }
    this.requireSignInAllowed()
    if (!started.ok) {
      throw new Error(
        started.status === 404
          ? 'This Orca Cloud does not support server sign-in yet.'
          : started.status === 429
            ? 'Too many sign-in requests from this network. Try again in a few minutes.'
            : 'Could not reach Orca Cloud. Try again.'
      )
    }
    const { deviceCode, userCode, verificationUri, expiresAt, interval } = started.value
    return {
      keypair,
      hostName,
      deviceCode,
      expiresAt,
      intervalMs: interval * 1000,
      prompt: { userCode, verificationUri, expiresAt }
    }
  }

  private async pollSignIn(flow: StartedSignIn, ended: AbortSignal): Promise<ConnectorHostLink> {
    const hostId = connectorHostId(flow.keypair)
    let intervalMs = flow.intervalMs
    for (;;) {
      await delayUnlessAborted(intervalMs, ended)
      this.requireCurrent(flow, ended)
      const polled = await requestConnector(
        {
          fetchImpl: this.fetchImpl,
          url: `${this.options.origin}${CONNECTOR_PATHS.signInPoll}`,
          body: { v: 1, deviceCode: flow.deviceCode },
          signal: ended
        },
        ConnectorSignInPollResponse
      )
      // Checked again after the answer, so nothing retired meanwhile can still link a key.
      this.requireCurrent(flow, ended)
      // Lost answers and outages wait out the interval; the poll carries no secret to lose.
      if (!polled.ok) {
        continue
      }
      const answer = polled.value
      intervalMs = answer.interval * 1000
      if (answer.status === 'denied') {
        throw new Error('Sign-in was denied.')
      }
      if (answer.status === 'expired') {
        throw new Error('Sign-in expired. Run `orca cloud login` again.')
      }
      if (answer.status === 'authorized') {
        if (answer.hostId !== hostId) {
          throw new Error(
            'Orca Cloud linked a different machine key. Run `orca cloud login` again.'
          )
        }
        const link = {
          hostId,
          email: answer.account.email,
          hostName: flow.hostName,
          linkedAt: this.now()
        }
        writeConnectorHostIdentity(this.options.userDataPath, { keypair: flow.keypair, link })
        return link
      }
    }
  }

  /** Unlinks in the cloud when it answers, then forgets the key either way. */
  async signOut(): Promise<{ signedOut: boolean }> {
    if (this.flow) {
      this.endFlow(this.flow)
    }
    const identity = readConnectorHostIdentity(this.options.userDataPath)
    if (!identity) {
      return { signedOut: false }
    }
    const session = new ConnectorHostSession(
      this.options.origin,
      identity.keypair,
      this.fetchImpl,
      this.now
    )
    const giveUp = AbortSignal.timeout(SIGN_OUT_UNBIND_TIMEOUT_MS)
    await Promise.race([
      session.call(CONNECTOR_PATHS.signOut, { v: 1 }, z.unknown(), { signal: giveUp }),
      delayUnlessAborted(SIGN_OUT_UNBIND_TIMEOUT_MS, giveUp)
    ])
    // Only the key this call unlinked; a login that finished meanwhile keeps its own.
    if (
      readConnectorHostIdentity(this.options.userDataPath)?.link.hostId === identity.link.hostId
    ) {
      deleteConnectorHostIdentity(this.options.userDataPath)
    }
    return { signedOut: true }
  }
}
