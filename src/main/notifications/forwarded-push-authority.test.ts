import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as bounded from '../../shared/node-bounded-file-reader'
import * as registry from '../../shared/runtime-environment-store-file'
import * as fingerprints from '../runtime/mobile-cloud-relay/relay-http-client'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairedRuntimeConnection,
  PersistedRuntimeEnvironmentSchema
} from '../../shared/runtime-environments'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import {
  createNotificationDeliveryService,
  type NotificationDeliveryDependencies
} from './notification-delivery-service'
import { createForwardedPushAuthority, forwardedPushBinding } from './forwarded-push-authority'

let root: string
const key = Buffer.alloc(32, 1).toString('base64')
const environment = (id = 'source') =>
  createEnvironmentFromPairingOffer({
    id,
    name: id,
    now: 1,
    runtimeId: null,
    offer: {
      v: 2,
      endpoint: 'ws://127.0.0.1:42000/runtime',
      deviceToken: 'token',
      publicKeyB64: key
    }
  })
const R = 'orca-environments.json'
const S = 'orca-environment-sidecar.json'
const W = 'orca-wsl-host-deployments.json'
function save(name: string, value: unknown) {
  writeFileSync(join(root, name), JSON.stringify(value))
}
function source() {
  const value = registry
    .readEnvironmentStore(root)
    .environments.find((entry) => entry.id === 'source')
  if (!value) {
    throw new Error('Expected current source')
  }
  return {
    root,
    environmentId: value.id,
    method: 'agentSession.subscribeTurnCompletions',
    binding: forwardedPushBinding(value, getPreferredPairedRuntimeConnection(value)),
    invalid: false
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr35901-authority-'))
  save(R, { version: 1, environments: [environment()] })
  save(S, { version: 1, entries: {} })
  save(W, { version: 1, deployments: [] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([25, 250])(
  'acquires fresh bytes but shares actual validation/view/hash for %s unrelated records and M distinct mobile events',
  (count) => {
    save(R, {
      version: 1,
      environments: [
        environment(),
        ...Array.from({ length: count }, (_, i) => environment(`other-${i}`))
      ]
    })
    const owner = source()
    const authority = createForwardedPushAuthority(() => root)
    const read = vi.spyOn(bounded, 'readNodeFileSyncWithinLimit')
    const decode = vi.spyOn(PersistedRuntimeEnvironmentSchema, 'safeParse')
    const view = vi.spyOn(registry, 'environmentStoreFromInputs')
    const hash = vi.spyOn(fingerprints, 'deriveRelayHostId')
    const mobile = vi.fn()
    const settings: NotificationSettings = {
      enabled: false,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: true,
      mutedNotificationSourceIds: [],
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      notifyHiddenWorkspaces: true
    }
    const deps: NotificationDeliveryDependencies = {
      readNotificationSettings: () => settings,
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: () => {},
      isNotificationSupported: () => false,
      dispatchMobileNotification: mobile,
      readAuthorizationStatus: async () => 'authorized',
      recordDeliveryOutcome: () => {},
      deliverNative: () => ({ delivered: true }),
      platform: 'linux',
      now: () => 1_800_000_000_000,
      resolveMobileOrigin: () => authority.resolve(owner, () => true)
    }
    const service = createNotificationDeliveryService(deps)
    const bytes = [R, S, W].reduce(
      (sum, file) => sum + readFileSync(join(root, file)).byteLength,
      0
    )
    for (const events of [1, 10, 30]) {
      mobile.mockClear()
      read.mockClear()
      decode.mockClear()
      view.mockClear()
      hash.mockClear()
      authority.clear()
      for (let i = 0; i < events; i++) {
        const request = {
          source: 'agent-task-complete' as const,
          occurrence: `${events}-${i}`,
          notificationId: 'subject'
        }
        service.dispatch(request)
        service.dispatch(request)
      }
      expect(mobile).toHaveBeenCalledTimes(events)
      expect(read).toHaveBeenCalledTimes(events * 3)
      expect(
        read.mock.results.reduce(
          (sum, result) => (result.type === 'return' ? sum + result.value.buffer.byteLength : sum),
          0
        )
      ).toBe(events * bytes)
      expect(decode).toHaveBeenCalledTimes(count + 1)
      expect(view).toHaveBeenCalledTimes(1)
      expect(hash).toHaveBeenCalledTimes(1)
      expect(
        mobile.mock.calls.every(
          ([payload]) =>
            payload.origin === fingerprints.deriveRelayHostId(Buffer.from(key, 'base64'))
        )
      ).toBe(true)
    }
    read.mockClear()
    service.dispatch({ source: 'test' })
    service.dispatch({ source: 'terminal-bell', mobileDeliveredByHost: true })
    expect(read).not.toHaveBeenCalled()
    // Larger harmless bytes remain physically acquired, without repeating semantic work.
    const text = readFileSync(join(root, R), 'utf8')
    writeFileSync(join(root, R), text + ' '.repeat(4096))
    read.mockClear()
    decode.mockClear()
    service.dispatch({ source: 'terminal-bell', occurrence: 'larger' })
    expect(
      read.mock.results.reduce(
        (sum, result) => (result.type === 'return' ? sum + result.value.buffer.byteLength : sum),
        0
      )
    ).toBe(bytes + 4096)
    expect(decode).toHaveBeenCalledTimes(count + 1)
  }
)

it('matches the serial reader through independent replacement/in-place writes, overlay phases, ambiguity, failure and repair', () => {
  const owner = source()
  let live = true
  const authority = createForwardedPushAuthority(() => root)
  const resolve = () => authority.resolve(owner, () => live)
  const expected = fingerprints.deriveRelayHostId(Buffer.from(key, 'base64'))
  const compare = () => {
    let qualified = false
    try {
      const current = registry
        .readEnvironmentStore(root)
        .environments.find((entry) => entry.id === 'source')
      qualified =
        !!current &&
        new Set(current.endpoints.map((entry) => entry.publicKeyB64)).size === 1 &&
        forwardedPushBinding(current, getPreferredPairedRuntimeConnection(current)) ===
          owner.binding
    } catch {}
    expect(resolve()).toBe(qualified ? expected : undefined)
  }
  compare()
  const original = readFileSync(join(root, R), 'utf8')
  const changed = original.replace('"token"', '"other"')
  expect(changed.length).toBe(original.length)
  writeFileSync(join(root, R), changed)
  compare()
  expect(resolve()).toBeUndefined()
  writeFileSync(join(root, 'replacement'), original)
  renameSync(join(root, 'replacement'), join(root, R))
  compare()
  // Bookkeeping changes do not retire a binding.
  save(R, {
    version: 1,
    environments: [{ ...environment(), name: 'renamed', runtimeId: 'new-runtime', lastUsedAt: 42 }]
  })
  compare()
  const paired = environment()
  const endpoint = paired.endpoints[0]
  if (!endpoint) {
    throw new Error('Expected endpoint')
  }
  save(R, {
    version: 1,
    environments: [
      {
        ...paired,
        endpoints: [
          endpoint,
          { ...endpoint, id: 'alternate', publicKeyB64: Buffer.alloc(32, 2).toString('base64') }
        ]
      }
    ]
  })
  compare()
  expect(resolve()).toBeUndefined()
  save(R, { version: 1, environments: [paired, { id: 'opaque', kind: 'future' }] })
  for (const entries of [{ unrelated: { future: true } }, { source: { future: true } }, {}]) {
    save(S, { version: 1, entries })
    compare()
  }
  // Current/pending sidecar binding and revision floor retain the existing serial semantics.
  for (const binding of [
    { createdAt: 2, pairingRevision: 2, preferredEndpointId: paired.preferredEndpointId },
    { createdAt: 1, pairingRevision: 1, preferredEndpointId: paired.preferredEndpointId }
  ]) {
    save(S, { version: 1, entries: { source: { binding, pairingRevisionFloor: 3 } } })
    compare()
  }
  save(S, { version: 1, entries: {} })
  const deployment = {
    kind: 'wsl',
    environmentId: 'source',
    distro: 'Ubuntu',
    distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
    localPort: 42000,
    remotePort: 6768,
    createdAt: 1,
    pairingPublicKeyB64: Buffer.alloc(32, 2).toString('base64'),
    previousPairingPublicKeyB64: key
  }
  for (const deployments of [
    [deployment],
    [deployment, deployment],
    [{ environmentId: 'source', kind: 'future' }],
    []
  ]) {
    save(W, { version: 1, deployments })
    compare()
  }
  writeFileSync(join(root, W), '{broken')
  compare()
  vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '0')
  compare()
  expect(resolve()).toBe(expected)
  vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
  compare()
  expect(resolve()).toBeUndefined()
  save(W, { version: 1, deployments: [] })
  compare()
  for (const file of [R, S, W]) {
    const bytes = readFileSync(join(root, file))
    writeFileSync(join(root, file), '\0')
    compare()
    writeFileSync(join(root, file), bytes)
    compare()
    rmSync(join(root, file))
    compare()
    writeFileSync(join(root, file), bytes)
    compare()
  }
  const readOriginal = bounded.readNodeFileSyncWithinLimit
  const denied = vi
    .spyOn(bounded, 'readNodeFileSyncWithinLimit')
    .mockImplementation((path, limit, options) => {
      if (path === join(root, S)) {
        throw new Error('EACCES')
      }
      return readOriginal(path, limit, options)
    })
  compare()
  expect(resolve()).toBeUndefined()
  denied.mockRestore()
  compare()
  live = false
  expect(resolve()).toBeUndefined()
  live = true
  compare()
  const priorRoot = root
  const other = mkdtempSync(join(tmpdir(), 'pr35901-other-root-'))
  try {
    root = other
    expect(resolve()).toBeUndefined()
  } finally {
    root = priorRoot
    rmSync(other, { recursive: true, force: true })
  }
  compare()
})

it('reacquires once on observed gate churn, then terminates through legacy', () => {
  const owner = source()
  const authority = createForwardedPushAuthority(() => root)
  const original = bounded.readNodeFileSyncWithinLimit
  let flip = true
  const read = vi
    .spyOn(bounded, 'readNodeFileSyncWithinLimit')
    .mockImplementation((path, limit, options) => {
      const result = original(path, limit, options)
      if (path === join(root, W)) {
        flip = !flip
        vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', flip ? '1' : '0')
      }
      return result
    })
  expect(authority.resolve(owner, () => true)).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(6)
  read.mockRestore()
  expect(authority.resolve(owner, () => true)).toBe(
    fingerprints.deriveRelayHostId(Buffer.from(key, 'base64'))
  )
})
