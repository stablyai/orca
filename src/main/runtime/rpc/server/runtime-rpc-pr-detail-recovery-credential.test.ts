import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DeviceEntry } from './pairing/device-entry'
import { DEVICE_REGISTRY_FILENAME } from './pairing/mobile-pairing-files'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { GITHUB_PR_DETAIL_RECOVERY_METHODS } from '../methods/source-control/github/github-pr-detail-recovery-methods'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

const startParams = {
  clientEpoch: { scope: 'g1000.panel', counter: 1 },
  cacheKey: '/repo::feature',
  identity: {
    sourceEpoch: 'runtime:test',
    repoId: 'repo',
    repoPath: '/repo',
    worktreeId: 'wt-1',
    branch: 'feature',
    currentHeadOid: 'h2',
    executionHostId: null,
    provider: 'github',
    linkedPRNumber: null,
    fallbackPRNumber: 7,
    fallbackPRSource: 'hosted-review',
    selectionRevision: ''
  }
}

it('refuses recovery if the paired credential is revoked while its candidate lookup awaits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr-recovery-credential-'))
  const runtime = new OrcaRuntimeService()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const resolving = new Promise<void>((resolve) => {
    entered = resolve
  })
  const resolver = vi
    .spyOn(runtime, 'resolvePRDetailRecoveryCandidate')
    .mockImplementation(async () => {
      entered()
      await held
      return {
        cacheKey: '/repo::feature',
        repoKind: 'git',
        repoId: 'repo',
        repoPath: '/repo',
        branch: 'feature',
        fallbackPRNumber: 7
      }
    })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    longPollCap: 1,
    methods: GITHUB_PR_DETAIL_RECOVERY_METHODS
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'Browser',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const reader = createEncryptedWsResponseReader(session)
  try {
    sendEncryptedWsRequest(session, {
      id: 'start',
      method: 'github.prDetailRecovery.start',
      params: startParams
    })
    await resolving
    sendEncryptedWsRequest(session, {
      id: 'duplicate-start',
      method: 'github.prDetailRecovery.start',
      params: startParams
    })
    expect(await reader.next('duplicate-start')).toMatchObject({
      ok: false,
      error: { code: 'runtime_busy' }
    })
    sendEncryptedWsRequest(session, {
      id: 'extra-wait',
      method: 'github.prDetailRecovery.wait',
      params: { ticketId: 'unknown', afterRevision: 0 }
    })
    expect(await reader.next('extra-wait')).toMatchObject({
      ok: false,
      error: { code: 'runtime_busy' }
    })
    sendEncryptedWsRequest(session, {
      id: 'cancel',
      method: 'github.prDetailRecovery.cancel',
      params: { ticketId: 'unknown' }
    })
    expect(await reader.next('cancel')).toMatchObject({ ok: true, result: null })
    const closed = new Promise<number>((resolve) => session.ws.once('close', resolve))
    server.getDeviceRegistry()?.removeDevice(offer.deviceId)
    release()
    expect(await closed).toBe(4001)
  } finally {
    release()
    reader.dispose()
    session.ws.close()
    resolver.mockRestore()
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['device', 'ancestor'] as const)(
  'observes external %s removal on an idle socket and only restores fresh authentication',
  async (removed) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pr-recovery-idle-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: directory,
      enableWebSocket: true,
      wsPort: 0,
      methods: GITHUB_PR_DETAIL_RECOVERY_METHODS
    })
    await server.start()
    const registry = server.getDeviceRegistry()!
    const parent = registry.addDevice('Ancestor', 'runtime')
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'Browser',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    if (removed === 'ancestor') {
      const rows: DeviceEntry[] = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(
        path,
        JSON.stringify(
          rows.map((row) =>
            row.deviceId === offer.deviceId ? { ...row, parentDeviceId: parent.deviceId } : row
          )
        )
      )
    }
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const device = registry.getDevice(offer.deviceId)!
    const principal = {
      deviceId: device.deviceId,
      credentialRevision: device.credentialRevision ?? 0,
      deviceToken: device.token
    }
    const authority = registry.captureAuthority(principal)!
    let restored: Awaited<ReturnType<typeof authenticateMobileWsSession>> | null = null
    try {
      const saved = readFileSync(path, 'utf8')
      const rows: DeviceEntry[] = JSON.parse(saved)
      const closed = new Promise<number>((resolve) => session.ws.once('close', resolve))
      const removedId = removed === 'device' ? offer.deviceId : parent.deviceId
      writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== removedId)))
      // No new RPC or authentication requests cause this revocation to be observed.
      expect(await closed).toBe(4001)
      expect(authority.signal.aborted).toBe(true)
      writeFileSync(path, saved)
      await vi.waitFor(
        () => expect(registry.validateToken(device.token!)?.deviceId).toBe(device.deviceId),
        { timeout: 5000 }
      )
      restored = await authenticateMobileWsSession(offer.pairingUrl)
      expect(registry.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()
      expect(registry.captureAuthority(principal)?.signal.aborted).toBe(false)
    } finally {
      restored?.ws.close()
      session.ws.close()
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('resumes the retained ticket after normal encrypted socket reconnection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr-recovery-reconnect-'))
  const runtime = new OrcaRuntimeService()
  const resolver = vi.spyOn(runtime, 'resolvePRDetailRecoveryCandidate').mockResolvedValue({
    cacheKey: '/repo::feature',
    repoKind: 'git',
    repoId: 'repo',
    repoPath: '/repo',
    branch: 'feature'
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    methods: GITHUB_PR_DETAIL_RECOVERY_METHODS
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'Browser',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const first = await authenticateMobileWsSession(offer.pairingUrl)
  const reader = createEncryptedWsResponseReader(first)
  const registry = server.getDeviceRegistry()!
  const device = registry.getDevice(offer.deviceId)!
  const authority = registry.captureAuthority({
    deviceId: device.deviceId,
    credentialRevision: device.credentialRevision ?? 0,
    deviceToken: device.token
  })!

  let second: Awaited<ReturnType<typeof authenticateMobileWsSession>> | null = null
  try {
    sendEncryptedWsRequest(first, {
      id: 'start-1',
      method: 'github.prDetailRecovery.start',
      params: startParams
    })
    const response = await reader.next('start-1')
    const result = response.result
    if (!result || typeof result !== 'object' || !('ticketId' in result)) {
      throw new Error('Missing ticket')
    }
    const ticketId = String(result.ticketId)
    expect(ticketId).not.toBe('')
    const closed = new Promise((resolve) => first.ws.once('close', resolve))
    first.ws.close()
    await closed
    second = await authenticateMobileWsSession(offer.pairingUrl)
    const resumed = createEncryptedWsResponseReader(second)
    try {
      sendEncryptedWsRequest(second, {
        id: 'start-2',
        method: 'github.prDetailRecovery.start',
        params: startParams
      })
      expect(await resumed.next('start-2')).toMatchObject({
        ok: true,
        result: { ticketId, admitted: false }
      })
    } finally {
      resumed.dispose()
    }
  } finally {
    reader.dispose()
    first.ws.close()
    second?.ws.close()
    resolver.mockRestore()
    await server.stop()
    expect(authority.signal.aborted).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})
