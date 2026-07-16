import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../shared/mobile-relay-close-codes'
import type { E2EEKeypair } from '../e2ee-keypair'
import {
  RelayConnectionOpenMessageSchema,
  RelayDrainMessageSchema,
  RelayHostChallengeMessageSchema,
  RelayHostHelloAckMessageSchema,
  RelayPingMessageSchema,
  parseRelayControlMessage,
  type RelayConnectionOpenMessage,
  type RelayDrainMessage,
  type RelayHostHelloAckMessage,
  type RelayInviteCreatedMessage
} from './relay-control-protocol'
import { RelayControlRequests } from './relay-control-requests'
import type { DeviceCredentialInstallAuthorization } from './relay-control-requests'
import { answerRelayHostChallenge } from './relay-host-proof'

type RelayControlState = 'idle' | 'opening' | 'proving' | 'active' | 'draining' | 'closed'

type RelayControlClientOptions = {
  cellUrl: string
  relayJwt: string
  relayHostId: string
  assignmentEpoch: number
  identity: { userId: string; profileId: string; organizationId: string }
  keypair: E2EEKeypair
  appVersion: string
  previousGeneration?: number
  controlResumeSecret?: string
  onConnectionOpen: (message: RelayConnectionOpenMessage) => void
  onDrain: (message: RelayDrainMessage) => void
  onClose: (code: number) => void
  createSocket?: (url: string, relayJwt: string) => WebSocket
}

function controlWebSocketUrl(cellUrl: string): { origin: string; url: string } {
  const parsed = new URL(cellUrl)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('relay_cell_url_must_be_an_origin')
  }
  const origin = parsed.origin
  if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:'
  } else if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:'
  } else {
    throw new Error('relay_cell_url_must_use_http')
  }
  return { origin, url: `${parsed.origin}/v1/host/control` }
}

export class RelayControlClient {
  private readonly options: RelayControlClientOptions
  private readonly relayOrigin: string
  private readonly controlUrl: string
  private readonly createSocket: NonNullable<RelayControlClientOptions['createSocket']>
  private readonly requests = new RelayControlRequests()
  private socket: WebSocket | null = null
  private state: RelayControlState = 'idle'
  private connectResolve: ((ack: RelayHostHelloAckMessage) => void) | null = null
  private connectReject: ((error: Error) => void) | null = null

  constructor(options: RelayControlClientOptions) {
    this.options = options
    const endpoint = controlWebSocketUrl(options.cellUrl)
    this.relayOrigin = endpoint.origin
    this.controlUrl = endpoint.url
    this.createSocket =
      options.createSocket ??
      ((url, token) =>
        new WebSocket(url, {
          headers: { authorization: `Bearer ${token}` },
          perMessageDeflate: false,
          maxPayload: 64 * 1024
        }))
  }

  connect(): Promise<RelayHostHelloAckMessage> {
    if (this.state !== 'idle') {
      return Promise.reject(new Error('relay_control_already_started'))
    }
    this.state = 'opening'
    const socket = this.createSocket(this.controlUrl, this.options.relayJwt)
    this.socket = socket
    socket.once('open', () => this.sendHostHello())
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.failProtocol('binary control message')
        return
      }
      this.handleMessage(raw)
    })
    socket.once('error', (error) => {
      if (this.state === 'opening' || this.state === 'proving') {
        this.connectReject?.(error)
        this.clearConnectPromise()
      }
    })
    socket.once('close', (code) => this.handleClose(code))
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })
  }

  get pendingRequestCount(): number {
    return this.requests.size
  }

  refreshAuthorization(relayJwt: string): void {
    this.sendActive({ type: 'auth-refresh', relayJwt })
  }

  createInvite(
    relayDeviceId: string,
    reqId: string = randomUUID()
  ): Promise<RelayInviteCreatedMessage> {
    return this.requests.createInvite(reqId, relayDeviceId, (payload) => this.sendActive(payload))
  }

  revokeDevice(relayDeviceId: string, reqId: string = randomUUID()): Promise<void> {
    return this.requests.revokeDevice(reqId, relayDeviceId, (payload) => this.sendActive(payload))
  }

  installCredential(input: {
    reqId: string
    relayDeviceId: string
    newResumeTokenHash: string
    expectedCurrentHash?: string
    authorization: DeviceCredentialInstallAuthorization
  }): ReturnType<RelayControlRequests['installCredential']> {
    const { reqId, ...request } = input
    return this.requests.installCredential(reqId, request, (payload) => this.sendActive(payload))
  }

  credentialInstallStatus(
    relayDeviceId: string,
    reqId: string
  ): ReturnType<RelayControlRequests['credentialInstallStatus']> {
    return this.requests.credentialInstallStatus(reqId, relayDeviceId, (payload) =>
      this.sendActive(payload)
    )
  }

  confirmResume(
    basisConnId: string,
    reqId: string
  ): ReturnType<RelayControlRequests['confirmResume']> {
    return this.requests.confirmResume(reqId, basisConnId, (payload) => this.sendActive(payload))
  }

  closeNow(): void {
    this.state = 'closed'
    this.requests.rejectAll(new Error('relay_control_closed'))
    this.socket?.terminate()
    this.socket = null
  }

  private sendHostHello(): void {
    if (!this.socket || this.state !== 'opening') {
      return
    }
    this.state = 'proving'
    this.socket.send(
      JSON.stringify({
        type: 'host-hello',
        v: 1,
        relayHostId: this.options.relayHostId,
        assignmentEpoch: this.options.assignmentEpoch,
        hostPublicKeyB64: this.options.keypair.publicKeyB64,
        appVersion: this.options.appVersion,
        ...(this.options.previousGeneration === undefined
          ? {}
          : { previousGeneration: this.options.previousGeneration }),
        ...(this.options.controlResumeSecret
          ? { controlResumeSecret: this.options.controlResumeSecret }
          : {})
      })
    )
  }

  private handleMessage(raw: RawData): void {
    const message = parseRelayControlMessage(raw)
    if (!message) {
      this.failProtocol('invalid control JSON')
      return
    }
    if (this.state === 'proving') {
      this.handleProofMessage(message)
      return
    }
    if (this.state !== 'active' && this.state !== 'draining') {
      this.failProtocol('control message before activation')
      return
    }
    if (RelayPingMessageSchema.safeParse(message).success) {
      this.socket?.send(JSON.stringify({ type: 'pong', t: message.t }))
      return
    }
    const connection = RelayConnectionOpenMessageSchema.safeParse(message)
    if (connection.success && this.state === 'active') {
      this.options.onConnectionOpen(connection.data)
      return
    }
    const drain = RelayDrainMessageSchema.safeParse(message)
    if (drain.success) {
      this.state = 'draining'
      this.options.onDrain(drain.data)
      return
    }
    if (this.requests.resolveMessage(message)) {
      return
    }
    this.failProtocol('unknown control message')
  }

  private handleProofMessage(message: Record<string, unknown>): void {
    const challenge = RelayHostChallengeMessageSchema.safeParse(message)
    if (challenge.success) {
      const proofB64 = answerRelayHostChallenge(challenge.data, {
        relayOrigin: this.relayOrigin,
        ...this.options.identity,
        relayHostId: this.options.relayHostId,
        hostPublicKey: this.options.keypair.publicKey,
        hostSecretKey: this.options.keypair.secretKey,
        assignmentEpoch: this.options.assignmentEpoch,
        previousGeneration: this.options.previousGeneration,
        resumeRequested: Boolean(this.options.controlResumeSecret)
      })
      if (!proofB64) {
        this.failProtocol('invalid host challenge')
        return
      }
      this.socket?.send(
        JSON.stringify({
          type: 'host-challenge-ack',
          challengeId: challenge.data.challengeId,
          proofB64
        })
      )
      return
    }
    const ack = RelayHostHelloAckMessageSchema.safeParse(message)
    if (!ack.success) {
      this.failProtocol('invalid host proof message')
      return
    }
    this.state = 'active'
    this.connectResolve?.(ack.data)
    this.clearConnectPromise()
  }

  private sendActive(payload: object): void {
    if (!this.socket || (this.state !== 'active' && this.state !== 'draining')) {
      throw new Error('relay_control_not_active')
    }
    this.socket.send(JSON.stringify(payload))
  }

  private failProtocol(reason: string): void {
    this.connectReject?.(new Error(reason))
    this.clearConnectPromise()
    this.socket?.close(MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, reason)
  }

  private handleClose(code: number): void {
    const wasConnecting = this.state === 'opening' || this.state === 'proving'
    this.state = 'closed'
    if (wasConnecting) {
      this.connectReject?.(new Error(`relay_control_closed_${code}`))
      this.clearConnectPromise()
    }
    this.requests.rejectAll(new Error(`relay_control_closed_${code}`))
    this.options.onClose(code)
  }

  private clearConnectPromise(): void {
    this.connectResolve = null
    this.connectReject = null
  }
}
