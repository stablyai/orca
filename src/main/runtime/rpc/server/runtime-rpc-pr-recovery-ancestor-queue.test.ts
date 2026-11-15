import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import type { DeviceEntry } from './pairing/device-entry'
import { DEVICE_REGISTRY_FILENAME } from './pairing/mobile-pairing-files'
import { seedRuntimePairingFamily } from './runtime-rpc-pairing-family.test-fixture'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

const { mocks, modules, preparation } = await vi.hoisted(async () => {
  const modules =
    await import('../../../github/pull-requests/refresh/pr-refresh-coordinator-test-mocks')
  const preparation: { held: Promise<void> | null; entered: () => void } = {
    held: null,
    entered: () => {}
  }
  return { mocks: modules.createPRRefreshCoordinatorMocks(), modules, preparation }
})
vi.mock('../../../github/pull-requests/refresh/pr-refresh-renderer-port', () =>
  modules.rendererPortModuleMock(mocks)
)
vi.mock('../../../github/client/lookup/pr-for-branch-outcome', () => {
  const client = modules.clientModuleMock(mocks)
  return {
    ...client,
    preparePRBranchRead: async (...args: Parameters<typeof client.preparePRBranchRead>) => {
      const prepared = await client.preparePRBranchRead(...args)
      if (preparation.held) {
        preparation.entered()
        await preparation.held
      }
      return prepared
    }
  }
})
vi.mock('../../../github/repositories/github-api-repository-remote-probe', () =>
  modules.githubApiRepositoryModuleMock(mocks)
)
vi.mock('../../../github/api/rate-limit', () => modules.rateLimitModuleMock(mocks))

import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { GITHUB_PR_DETAIL_RECOVERY_METHODS } from '../methods/source-control/github/github-pr-detail-recovery-methods'

function ticket(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ticketId' in value) ||
    typeof value.ticketId !== 'string' ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !('admitted' in value) ||
    typeof value.admitted !== 'boolean'
  ) {
    throw new Error('Expected a recovery ticket')
  }
  let preparation: { token: string } | undefined
  if ('preparation' in value && value.preparation !== undefined) {
    const prepared = value.preparation
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      !('token' in prepared) ||
      typeof prepared.token !== 'string'
    ) {
      throw new Error('Expected a preparation token')
    }
    preparation = { token: prepared.token }
  }
  return {
    ticketId: value.ticketId,
    revision: value.revision,
    admitted: value.admitted,
    preparation,
    terminal: 'terminal' in value ? value.terminal : undefined
  }
}

it('cancels an encrypted committed read on ancestor loss before dispatch and keeps its restored socket fresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ancestor-queue-'))
  const { parent, child } = seedRuntimePairingFamily(directory)
  const runtime = new OrcaRuntimeService()
  const resolver = vi.spyOn(runtime, 'resolvePRDetailRecoveryCandidate').mockResolvedValue({
    cacheKey: '/repo::feature',
    repoKind: 'git',
    repoId: 'repo',
    repoPath: '/repo',
    branch: 'feature',
    fallbackPRNumber: 7
  })
  mocks.getOriginGitHubApiRepositoryMock.mockResolvedValue({
    owner: 'acme',
    repo: 'widgets',
    host: 'github.com'
  })
  mocks.getRateLimitMock.mockResolvedValue({ ok: true })
  mocks.repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
  mocks.spendsSharedGitHubComQuotaMock.mockReturnValue(false)
  mocks.getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1000 })
  let release!: () => void
  preparation.held = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparing = new Promise<void>((resolve) => {
    preparation.entered = resolve
  })
  let originalContext: RpcContext | null = null
  const methods = eraseRpcMethods(GITHUB_PR_DETAIL_RECOVERY_METHODS)
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    methods: methods.map((method) => ({
      ...method,
      handler: (params: unknown, context: RpcContext) => {
        if (method.name === 'github.prDetailRecovery.start') {
          originalContext ??= context
        }
        return method.handler(params, context)
      }
    }))
  })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  expect(offer.deviceId).toBe(child.deviceId)
  expect(offer.deviceId).not.toBe(parent.deviceId)
  expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.parentDeviceId).toBe(
    parent.deviceId
  )
  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const reader = createEncryptedWsResponseReader(session)
  let restored: Awaited<ReturnType<typeof authenticateMobileWsSession>> | null = null
  const params = {
    clientEpoch: { scope: 'g1000.ancestor', counter: 1 },
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
  try {
    sendEncryptedWsRequest(session, {
      id: 'start',
      method: 'github.prDetailRecovery.start',
      params
    })
    const started = await reader.next('start')
    expect(started).toMatchObject({ ok: true })
    let snapshot = ticket(started.result)
    while (!snapshot.preparation) {
      expect(snapshot.terminal).toBeUndefined()
      sendEncryptedWsRequest(session, {
        id: 'prepare',
        method: 'github.prDetailRecovery.wait',
        params: { ticketId: snapshot.ticketId, afterRevision: snapshot.revision }
      })
      const prepared = await reader.next('prepare')
      expect(prepared).toMatchObject({ ok: true })
      snapshot = ticket(prepared.result)
    }
    sendEncryptedWsRequest(session, {
      id: 'commit',
      method: 'github.prDetailRecovery.commit',
      params: {
        ticketId: snapshot.ticketId,
        prepareToken: snapshot.preparation.token,
        publicationGrantId: 'ancestor-grant'
      }
    })
    const committed = ticket((await reader.next('commit')).result)
    expect(committed.admitted).toBe(false)
    await preparing
    sendEncryptedWsRequest(session, {
      id: 'pending-wait',
      method: 'github.prDetailRecovery.wait',
      params: { ticketId: snapshot.ticketId, afterRevision: committed.revision }
    })
    const closed = new Promise<number>((resolve) => session.ws.once('close', resolve))
    const delivered = Promise.race([
      reader.next('pending-wait').then(() => 'reply'),
      closed.then(() => 'revoked')
    ])
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const saved = readFileSync(path, 'utf8')
    const rows: DeviceEntry[] = JSON.parse(saved)
    writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== parent.deviceId)))
    expect(await closed).toBe(4001)
    expect(await delivered).toBe('revoked')
    const wait = methods.find((method) => method.name === 'github.prDetailRecovery.wait')!
    const pending = { ticketId: snapshot.ticketId, afterRevision: -1 }
    expect(await wait.handler(pending, originalContext!)).toMatchObject({
      admitted: false,
      terminal: { kind: 'cancelled' }
    })
    release()
    expect(await wait.handler(pending, originalContext!)).toMatchObject({
      admitted: false,
      terminal: { kind: 'cancelled' }
    })

    writeFileSync(path, saved)
    await vi.waitFor(
      () =>
        expect(server.getDeviceRegistry()?.validateToken(child.token)?.deviceId).toBe(
          child.deviceId
        ),
      { timeout: 5000 }
    )
    restored = await authenticateMobileWsSession(offer.pairingUrl)
    const resumed = createEncryptedWsResponseReader(restored)
    try {
      sendEncryptedWsRequest(restored, {
        id: 'old-ticket',
        method: 'github.prDetailRecovery.wait',
        params: { ticketId: snapshot.ticketId, afterRevision: 0 }
      })
      expect(await resumed.next('old-ticket')).toMatchObject({ ok: true, result: null })
      sendEncryptedWsRequest(restored, {
        id: 'fresh-ticket',
        method: 'github.prDetailRecovery.start',
        params
      })
      const fresh = ticket((await resumed.next('fresh-ticket')).result)
      expect(fresh.ticketId).not.toBe(snapshot.ticketId)
      expect(fresh.admitted).toBe(false)
      expect(fresh.terminal).toBeUndefined()
    } finally {
      resumed.dispose()
    }
  } finally {
    release()
    preparation.held = null
    preparation.entered = () => {}
    reader.dispose()
    session.ws.close()
    restored?.ws.close()
    resolver.mockRestore()
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
