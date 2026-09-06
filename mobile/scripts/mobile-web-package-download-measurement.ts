// Harness behind scripts/measure-mobile-web-package-download.mjs. It drives the real mobile
// package downloader over the real mobile RPC clients (direct WebSocket and the cloud-relay
// session) against the real desktop MobileWebPackageAssets reader, with an injectable per-hop
// delay so a cloud round trip can be modelled on loopback.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import {
  downloadMobileWebPackage,
  type MobileWebPackageStager
} from '../src/mobile-web/mobile-web-package-downloader'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../src/shared/mobile-web/bridge-contract'
import type { MobileWebPackageAssetParams } from '../../src/shared/mobile-web/package-rpc-contract'
import type { MobileRelayEndpoint } from '../../src/shared/mobile-relay-credential-contract'
import { DeviceRegistry } from '../../src/main/runtime/device-registry'
import { MobileSocketWiring } from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { deriveRelayHostId } from '../../src/main/runtime/relay/relay-http-client'
import { MobileWebPackageAssets } from '../../src/main/runtime/rpc/mobile-web-package-assets'
import {
  openDirectClient,
  openRelayClient,
  type Teardown
} from './mobile-web-package-download-loopback-clients'

export type MeasurementOptions = {
  path: 'direct' | 'relay'
  packageRoot: string
  oneWayDelayMs: number
  gzip: boolean
  rangeBytes: number
  maxConcurrentRequests: number
}

export type MeasurementResult = MeasurementOptions & {
  totalBytes: number
  wallMs: number
  bytesPerSecond: number
  chunkRequests: number
  wireBytesToPhone: number
  latencyMedianMs: number
  latencyP95Ms: number
  peakInFlight: number
}

type MeasurementRpcRequest = { id: string; method: string; params?: Record<string, unknown> }

export async function measureMobileWebPackageDownload(
  options: MeasurementOptions
): Promise<MeasurementResult> {
  const teardown: Teardown = []
  try {
    const packageAssets = new MobileWebPackageAssets({ resolveRoot: () => options.packageRoot })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-package-measure-'))
    teardown.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Measurement phone', 'mobile')
    const desktopKeys = nacl.box.keyPair()
    const desktopPublicKeyB64 = Buffer.from(desktopKeys.publicKey).toString('base64')
    const relayHostId = deriveRelayHostId(desktopKeys.publicKey)
    const relayEndpoint: MobileRelayEndpoint = {
      v: 1,
      directorUrl: 'https://relay.measure.test',
      cellUrl: 'https://relay-c1.measure.test',
      assignmentEpoch: 1,
      relayHostId,
      e2eeFraming: 2
    }

    let wireBytesToPhone = 0
    const countInbound = (bytes: number): void => {
      wireBytesToPhone += bytes
    }
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktopKeys.publicKey,
        secretKey: desktopKeys.secretKey,
        publicKeyB64: desktopPublicKeyB64
      },
      onText: (socket, plaintext, reply) => {
        const request = JSON.parse(plaintext) as MeasurementRpcRequest
        if (request.method === 'pairing.getEndpoints') {
          reply(
            rpcSuccess(request.id, {
              v: 1,
              relay: relayEndpoint,
              resumeConfirmation: {
                v: 1,
                reqId: request.params?.resumeConfirmReqId,
                currentVersion: 3,
                acceptedAs: 'current',
                renewed: true,
                resumeExpiresAt: Date.now() + 900_000
              }
            })
          )
          return
        }
        const params = request.params as unknown as MobileWebPackageAssetParams
        const readOptions = { connectionId: socket.connectionId }
        if (request.method === 'mobileWeb.package.manifest') {
          settle(request.id, packageAssets.getManifest(), reply)
          return
        }
        if (request.method === 'mobileWeb.package.asset') {
          settle(request.id, packageAssets.getAssetChunk(params, readOptions), reply)
          return
        }
        if (request.method === 'mobileWeb.package.asset.gzip') {
          settle(request.id, packageAssets.getAssetGzipChunk(params, readOptions), reply)
          return
        }
        reply(rpcSuccess(request.id, {}))
      },
      onBinary: () => {},
      onClose: () => {}
    })

    const client =
      options.path === 'relay'
        ? await openRelayClient({
            wiring,
            relayEndpoint,
            relayHostId,
            relayDeviceId: device.deviceId,
            deviceToken: device.token,
            desktopPublicKeyB64,
            oneWayDelayMs: options.oneWayDelayMs,
            teardown,
            countInbound
          })
        : await openDirectClient({
            wiring,
            deviceToken: device.token,
            desktopPublicKeyB64,
            oneWayDelayMs: options.oneWayDelayMs,
            teardown,
            countInbound
          })

    const latencies: number[] = []
    let chunkRequests = 0
    let inFlight = 0
    let peakInFlight = 0
    const startedAt = performance.now()
    const downloaded = await downloadMobileWebPackage(
      async (method, params) => {
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        const requestStartedAt = performance.now()
        try {
          return await client.sendRequest(method, params, { timeoutMs: 180_000 })
        } finally {
          inFlight -= 1
          if (method !== 'mobileWeb.package.manifest') {
            chunkRequests += 1
            latencies.push(performance.now() - requestStartedAt)
          }
        }
      },
      createDiscardingStager(),
      {
        shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        useGzip: options.gzip,
        rangeBytes: options.rangeBytes,
        maxConcurrentRequests: options.maxConcurrentRequests
      }
    )
    const wallMs = performance.now() - startedAt
    client.close()
    return {
      ...options,
      totalBytes: downloaded.manifest.totalBytes,
      wallMs,
      bytesPerSecond: downloaded.manifest.totalBytes / (wallMs / 1000),
      chunkRequests,
      wireBytesToPhone,
      latencyMedianMs: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      peakInFlight
    }
  } finally {
    for (const dispose of teardown.toReversed()) {
      await dispose()
    }
  }
}

function createDiscardingStager(): MobileWebPackageStager<{ buildId: string }> {
  return {
    async begin() {},
    async writeAssetChunk() {},
    async finishAsset() {},
    async commit(manifest) {
      return { buildId: manifest.buildId }
    },
    async abort() {}
  }
}

function settle(id: string, operation: Promise<unknown>, reply: (response: string) => void): void {
  void operation.then(
    (result) => reply(rpcSuccess(id, result)),
    (error: unknown) =>
      reply(
        JSON.stringify({
          id,
          ok: false,
          error: { code: 'invalid_argument', message: String((error as Error).message) },
          _meta: { runtimeId: 'measure-runtime' }
        })
      )
  )
}

function rpcSuccess(id: string, result: unknown): string {
  return JSON.stringify({ id, ok: true, result, _meta: { runtimeId: 'measure-runtime' } })
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))]!
}
