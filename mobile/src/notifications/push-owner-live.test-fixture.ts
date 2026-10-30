import { pushOwnerNativePorts } from './push-owner-native-ports.test-fixture'
import { runObservationPhone } from './push-rfp1-phone.test-fixture'
import { expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  companion,
  httpResult,
  integer,
  post,
  record,
  text
} from '../../../cloud/apps/push/src/push-owner-integration.test-fixture'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { AppState } from 'react-native'
import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { savePairedHost, removeHost } from '../transport/host-store'
import * as publication from './push-route-declaration'
import { pushRoutePreparationSnapshotForTests } from './push-route-declaration-build'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  startPushTokenSync
} from './push-registration'

const ports = pushOwnerNativePorts()

it('runs the actual current-owner, prepared sender and signed publisher against live parent desktop/cloud actors', async () => {
  const base = text(process.env.ORCA_PUSH_OWNER_BRIDGE)
  if (process.env.ORCA_PUSH_OWNER_EXPERIMENT === '1') {
    await runObservationPhone(base)
    return
  }
  const nativeFetch = globalThis.fetch
  let stop: (() => void) | undefined
  const detach: (() => void)[] = []
  let renewalPhase = false
  let firstUse = true
  const bothPreparations = Promise.withResolvers<void>()
  const prepare = publication.mobilePushRouteKey
  let preparationCount = 0
  const retired: boolean[] = []
  const preparations = vi.spyOn(publication, 'mobilePushRouteKey').mockImplementation((current) => {
    const result = prepare(current)
    const index = retired.push(false) - 1
    void result.result.then((value) => {
      retired[index] = value.status === 'retired'
    })
    if (++preparationCount === 2) {
      bothPreparations.resolve()
    }
    return result
  })
  let clock = 1_700_000_000_000
  const drain = () => vi.advanceTimersByTimeAsync(0)
  const client = (host: string): RpcOperationSender => ({
    sendRequest: async (method, params, options) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Actual transport response timeout')),
          options?.timeoutMs ?? 5000
        )
      })
      const response = post(base, '/rpc', { host, method, params }).then(async (result) => {
        const token = record(params ?? {}).token
        const observation = token == null ? method : text(token)
        await post(base, '/event', {
          name: `${firstUse ? 'first-observed' : 'observed'}:${host}:${observation}`,
          data: result
        })
        if (renewalPhase && method === 'notifications.registerPush') {
          await post(base, '/event', { name: `renewed:${host}`, data: result })
        }
        return { id: 'mobile-transport', ok: true as const, result }
      })
      try {
        return await Promise.race([response, timeout])
      } finally {
        clearTimeout(timer)
      }
    }
  })
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  vi.setSystemTime(clock)
  // Only actual publisher HTTP goes over this port; bridge control fetches use the saved native function.
  vi.stubGlobal('fetch', ((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith(base)) {
      return nativeFetch(url, init)
    }
    return nativeFetch(`${base}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body
      })
    }).then(async (response) => httpResult(await response.json()))
  }) satisfies typeof fetch)
  try {
    await companion('mobile', async (op, data) => {
      if (op === 'start') {
        ports.storage.set('orca:pushServiceNotificationsEnabled', 'true')
        ports.storage.set('orca:hosts', JSON.stringify(data.profiles))
        expect(ports.keys.size).toBe(0)
        expect(ports.storage.has('orca:push-route-version')).toBe(false)
        ports.keyRead = Promise.withResolvers<void>()
        ports.keyReadStarted = Promise.withResolvers<void>()
        stop = startPushTokenSync()
        await ports.keyReadStarted.promise
      } else if (op === 'attach') {
        expect(ports.keyReads).toBe(1)
        for (const host of ['A', 'B']) {
          detach.push(attachPushRegistration(host, client(host)))
        }
        await bothPreparations.promise
      } else if (op === 'retire-first-use') {
        for (const token of ['c'.repeat(64), 'b'.repeat(64)]) {
          if (!ports.listener) {
            throw new Error('Missing current native owner')
          }
          ports.native = { ...ports.native, token }
          ports.listener(ports.native)
          await drain()
          expect(pushRoutePreparationSnapshotForTests()).toMatchObject({
            keyTask: 1,
            keyEntries: 3,
            creator: 0,
            builder: 1,
            latest: 0
          })
        }
        expect(retired.slice(0, 4)).toEqual([true, true, true, true])
        expect(ports.keyReads).toBe(1)
        expect(ports.keyWrites).toBe(0)
      } else if (op === 'release-key') {
        expect(preparations).toHaveBeenCalledTimes(6)
        expect(preparations.mock.calls.slice(-2).every(([current]) => current())).toBe(true)
        expect(ports.keyWrites).toBe(0)
        expect(ports.keyReads).toBe(1)
        ports.keyRead?.resolve()
      } else if (op === 'begin-rollover') {
        firstUse = false
        ports.native = { platform: 'ios', token: 'a'.repeat(64), apnsEnvironment: 'production' }
        if (!ports.listener) {
          throw new Error('Missing native owner')
        }
        ports.listener(ports.native)
      } else if (op === 'token') {
        ports.native = { platform: 'ios', token: text(data.token), apnsEnvironment: 'production' }
        if (!ports.listener) {
          throw new Error('Native owner listener missing')
        }
        ports.listener(ports.native)
      } else if (op === 'advance') {
        const delta = integer(data.delta)
        clock += delta
        await vi.advanceTimersByTimeAsync(delta)
      } else if (op === 'foreground') {
        renewalPhase = true
        if (!ports.foreground) {
          throw new Error('Missing renewal owner')
        }
        ports.foreground('active')
      } else if (op === 'fault') {
        ports.fault = text(data.kind)
        if (ports.fault === 'catalog-race') {
          ports.finalFailure = Promise.withResolvers<void>()
        }
        ports.reads = 0
        ports.writes = 0
        ports.foreground?.('active')
      } else if (op === 'disconnect') {
        for (const release of detach.splice(0)) {
          release()
        }
      } else if (op === 'background') {
        AppState.currentState = 'background'
        ports.foreground?.('background')
      } else if (op === 'repair') {
        ports.fault = ''
        AppState.currentState = 'active'
        if (!ports.foreground) {
          throw new Error('Lifecycle owner missing')
        }
        ports.foreground('active')
      } else if (op === 'release-failure') {
        ports.finalFailure?.resolve()
      } else if (op === 'restore-cap-catalog') {
        const original = await readStoredHostProfilesForMutation()
        const extra = Array.from({ length: 98 }, (_, index) => ({
          id: `offline-${index}`,
          name: `Offline ${index}`,
          endpoint: 'ws://127.0.0.1:1',
          lastConnected: 0,
          publicKeyB64: Buffer.from(
            nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(index + 1)).publicKey
          ).toString('base64')
        }))
        ports.storage.set('orca:hosts', JSON.stringify([...original, ...extra]))
        ports.foreground?.('active')
      } else if (op === 'mutate-cap-catalog') {
        for (const index of [201, 202]) {
          await savePairedHost({
            id: `new-${index}`,
            name: 'New pairing',
            endpoint: 'ws://127.0.0.1:1',
            lastConnected: 0,
            publicKeyB64: Buffer.from(
              nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(index)).publicKey
            ).toString('base64'),
            deviceToken: 'controlled-fixture-pairing-token'
          })
        }
        await removeHost('offline-0')
      } else if (op === 'restart') {
        stop?.()
        stop = startPushTokenSync()
      } else if (op !== 'drain' && op !== 'stats') {
        throw new Error(`Unknown mobile command ${op}`)
      }
      await drain()
      return {
        reads: ports.reads,
        writes: ports.writes,
        bytes: ports.bytes,
        preparations: preparations.mock.calls.length,
        retired: retired.filter(Boolean).length,
        preparationState: pushRoutePreparationSnapshotForTests(),
        keyReads: ports.keyReads,
        keyWrites: ports.keyWrites,
        metadataReads: ports.metadataReads,
        metadataWrites: ports.metadataWrites,
        routeKey: ports.keys.has('orca.push-route-key')
          ? Buffer.from(
              nacl.sign.keyPair.fromSecretKey(
                Buffer.from(text(ports.keys.get('orca.push-route-key')), 'base64')
              ).publicKey
            ).toString('base64url')
          : null,
        version: ports.storage.get('orca:push-route-version')
      }
    })
    expect(ports.storage.get('orca:pushServiceNotificationsEnabled')).toBe('true')
  } finally {
    ports.keyRead?.resolve()
    ports.finalFailure?.resolve()
    stop?.()
    preparations.mockRestore()
    resetPushRegistrationForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
}, 120_000)
