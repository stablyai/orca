import { expect, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  createPairedE2EEClientHandshake,
  type PairedE2EEFraming
} from '../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { createHash } from 'node:crypto'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../shared/delegated-mobile-device-contract'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'
import { RespondParams } from '../../../shared/rpc-contract/structured-agent-session-approval-params'
import { RUNTIME_ORDINARY_MESSAGE_MAX_BYTES as M } from '../../../shared/runtime-ordinary-message-capability'
import { defineMethod } from '../rpc/core'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

export const TARGET = 'runtime:env-1'
export type Frame = Record<string, unknown>

export function pair(
  server: OrcaRuntimeRpcServer,
  scope: 'mobile' | 'runtime',
  name: string
): PairingOffer {
  const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(offer.pairingUrl)!
}

export async function connectPhone(
  desktop: OrcaRuntimeRpcServer,
  name: string,
  cleanups: (() => Promise<void> | void)[],
  framing: PairedE2EEFraming = 'legacy'
) {
  const pairing = pair(desktop, 'mobile', name)
  // The installed client handshake, so a v2 phone seals and opens exactly as a real one does.
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64: pairing.publicKeyB64,
    framing,
    transport: 'direct'
  })
  const { channel } = handshake
  const ws = new WebSocket(pairing.endpoint)
  const frames: Frame[] = []
  const binaries: Uint8Array[] = []
  let ready = false
  let authenticated = false
  const opened = new Promise<void>((resolve) => {
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) {
        binaries.push(channel.openBinary(new Uint8Array(data))!)
        return
      }
      const text = data.toString()
      if (!ready) {
        ready = handshake.acceptReadyText(text) === 'accepted'
        void handshake
          .sealAuth({ kind: 'token', deviceToken: pairing.deviceToken })
          .then((auth) => ws.send(auth))
        return
      }
      const plaintext = channel.openText(text)!
      if (!authenticated) {
        authenticated = handshake.classifyAuthReply(plaintext).kind === 'authenticated'
        resolve()
        return
      }
      frames.push(z.record(z.string(), z.unknown()).parse(JSON.parse(plaintext)))
    })
  })
  ws.once('open', () => ws.send(handshake.helloText()))
  await opened
  cleanups.push(() => ws.close())
  const token = pairing.deviceToken
  return {
    token,
    deviceId: pairing.pairedDeviceId!,
    frames,
    binaries,
    close: () => ws.close(),
    send(
      id: string,
      method: string,
      params: unknown,
      executionHost: string | null = TARGET,
      expectedRuntimeSource?: { sourceId: string; runtimeId: string },
      untrustedScope?: { callerScope: string; clientKind: string }
    ) {
      ws.send(
        channel.sealText(
          JSON.stringify({
            ...untrustedScope,
            id,
            deviceToken: token,
            method,
            params,
            executionHost: executionHost ?? undefined,
            ...(expectedRuntimeSource ? { expectedRuntimeSource } : {})
          })
        )
      )
    },
    next: (id: string, predicate: (frame: Frame) => boolean = () => true) =>
      vi.waitFor(() => {
        const frame = frames.find((candidate) => candidate.id === id && predicate(candidate))
        expect(frame).toBeDefined()
        return frame!
      })
  }
}

/** The desktop's view of one paired server at env-1; tests flip `capable` and retire it. */
export function relayHostsFor(pairing: PairingOffer) {
  const syncedNames: string[][] = []
  const retirementListeners = new Set<(environmentId: string) => void>()
  const state = {
    pairing,
    capable: true,
    hostedPages: new Set<string>(),
    retire: (environmentId: string) =>
      retirementListeners.forEach((listener) => listener(environmentId))
  }
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: [],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async (environmentId) =>
      environmentId === 'env-1'
        ? { environmentId, fence: state.pairing.endpoint, pairing: state.pairing }
        : null,
    call: async (_host, method, params) => {
      if (method === DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
        const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
        syncedNames.push(phones.map((phone) => phone.name))
      }
      const response = await sendRemoteRuntimeRequest(
        pairedRuntimeConnectionFromOffer(state.pairing),
        method,
        params,
        5_000
      )
      return method === 'status.get' && !state.capable && response.ok
        ? {
            ...response,
            result: { ...z.object({}).passthrough().parse(response.result), capabilities: [] }
          }
        : response
    },
    hostsBrowserPage: (environmentId, browserPageId) =>
      environmentId === 'env-1' && state.hostedPages.has(browserPageId),
    onEnvironmentRetired: (listener) => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    },
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
  return { hosts, state, syncedNames }
}

// The server's real dispatch and form schema; only the answer is a fixture, echoing what arrived.
export const answeredForms: { content: unknown; pairedDeviceId?: string }[] = []
export const ECHO_FORM_METHODS = [
  defineMethod({
    name: 'agentSession.respondToApproval',
    permission: 'workspace',
    params: RespondParams,
    handler: async (params, { pairedDeviceId }) => {
      answeredForms.push({ content: params.content, pairedDeviceId })
      return { content: params.content }
    }
  })
]

export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A 64-answer form whose phone request plaintext is exactly the ordinary maximum. */
export function maximumRelayedForm(deviceToken: string) {
  const content = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`field-${i}`, 'x'.repeat(65534)])
  )
  const params = {
    envelope: {
      sessionId: 'session-alpha',
      clientOperationId: 'op-1',
      expectedRuntimeFence: 1,
      payloadFingerprint: 'f'.repeat(64)
    },
    itemId: 'item-1',
    expectedRevision: 1,
    content
  }
  const bytes = () =>
    Buffer.byteLength(
      JSON.stringify({
        id: 'form',
        deviceToken,
        method: 'agentSession.respondToApproval',
        params,
        executionHost: TARGET
      })
    )
  content['field-0'] = 'x'.repeat(65534 - (bytes() - M))
  expect(bytes()).toBe(M)
  return { params, content }
}
