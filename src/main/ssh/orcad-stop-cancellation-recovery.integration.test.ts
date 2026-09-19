import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as os from 'node:os'
import type * as activationLock from './orcad-activation-lock'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  configureOrcadDecommission,
  requestOrcadManagedDecommission,
  requestOrcadManagedStopCancellation
} from '../orcad/orcad-decommission'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'
import { readOrcadCanceledStopReceipt } from '../orcad/orcad-canceled-stop-receipt'
import { recordOrcadManagedStopDispatch } from '../orcad/orcad-managed-stop-dispatch'
import { cancelInterruptedOrcadManagedStop } from './orcad-managed-stop-cancellation'
import {
  emptyOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from './orcad-activation-record'
import {
  createOrcadDecommissionTransaction,
  serializeOrcadActivationTransaction
} from './orcad-activation-transaction'
import { orcadActivationTransactionRoot } from './orcad-activation-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { OrcadManagedStopRequest } from '../../shared/orcad-managed-stop-request'

const state = vi.hoisted(() => ({ home: '', cleanupFailure: false, releases: 0 }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => state.home
}))
// Transport reads and lock ownership are simulated; host validation and receipt persistence are real.
vi.mock('./orcad-remote-record-file', () => ({
  readBoundedOrcadRemoteRecord: async (_options: unknown, path: string, limit: number) => {
    if (!existsSync(path)) {
      return ''
    }
    const raw = readFileSync(path)
    if (raw.byteLength > limit) {
      throw new Error('Record exceeds read limit')
    }
    return raw.toString('utf8')
  }
}))
vi.mock('./orcad-activation-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof activationLock>()),
  withStaleOrcadActivationRecoveryLock: async (
    options: { host: ReturnType<typeof getRemoteHostPlatform>; remoteHome: string },
    run: (control: { retain(): void }) => Promise<unknown>
  ) => {
    let retained = false
    const result = await run({
      retain: () => {
        retained = true
      }
    })
    if (!retained) {
      if (state.cleanupFailure) {
        throw new Error('Cleanup failed before removal')
      }
      rmSync(orcadActivationTransactionRoot(options.host, options.remoteHome), { recursive: true })
      state.releases += 1
    }
    return result
  }
}))

beforeEach(() => {
  state.home = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-cancel-recovery-')))
  state.cleanupFailure = false
  state.releases = 0
})
afterEach(() => {
  configureOrcadDecommission(null)
  rmSync(state.home, { recursive: true, force: true })
})

function prepare(dispatched = true) {
  const host = getRemoteHostPlatform('linux-x64')
  const profileRoot = join(state.home, 'profile')
  mkdirSync(profileRoot)
  const identity = { runtimeId: 'runtime', profileId: 'profile', profileRoot }
  const authority = { ...identity, transactionId: '11111111-1111-4111-8111-111111111111' }
  const instance = {
    pid: 123,
    startedAtMs: null,
    nonce: 'original',
    lockPath: join(state.home, 'orcad.lock')
  }
  const version = '0.1.0+test'
  const before = {
    ...emptyOrcadActivationRecord(),
    active: version,
    activatedAt: new Date(1).toISOString()
  }
  const accepted = withDecommissioningVersion(before, new Date(2))
  const transaction = createOrcadDecommissionTransaction({
    transactionId: authority.transactionId,
    authority,
    instance,
    activeVersion: version,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  })
  const root = orcadActivationTransactionRoot(host, state.home)
  mkdirSync(root, { recursive: true })
  const transactionPath = join(root, 'transaction.json')
  const activationPath = join(state.home, '.orca-remote', 'orcad-active.json')
  writeFileSync(transactionPath, serializeOrcadActivationTransaction(transaction))
  writeFileSync(activationPath, serializeOrcadActivationRecord(before))
  const admission = new PtyOwnershipTransferAdmissionRecord(profileRoot, identity.runtimeId)
  if (dispatched) {
    admission.close(authority)
    admission.reopenAfterConfirmedNativeRefusal(authority)
  }
  const retire = vi.fn()
  // This fixture supplies admission proof, not a native PTY or live-registry proof.
  configureOrcadDecommission(retire, identity, instance, (owner) => admission.assertOpenFor(owner))
  const request: OrcadManagedStopRequest = { schemaVersion: 1, version, authority, instance }
  if (dispatched) {
    recordOrcadManagedStopDispatch(request.version, request.authority, request.instance)
  }
  const rpc = vi.fn(async (params: OrcadManagedStopRequest) =>
    requestOrcadManagedStopCancellation(params, version, identity.runtimeId)
  )
  return {
    request,
    retire,
    rpc,
    root,
    transactionPath,
    activationPath,
    before,
    options: {
      conn: {} as never,
      host,
      remoteHome: state.home,
      runtimeId: identity.runtimeId,
      requestCancellation: rpc
    }
  }
}

it.each([
  { failure: 'reply-loss', dispatched: true },
  { failure: 'cleanup-failure', dispatched: true },
  { failure: 'reply-loss', dispatched: false },
  { failure: 'cleanup-failure', dispatched: false }
])(
  'recovers $failure without accepting a delayed stop or changing activation (dispatched=$dispatched)',
  async ({ failure, dispatched }) => {
    const fixture = prepare(dispatched)
    const original = readFileSync(fixture.transactionPath, 'utf8')
    if (failure === 'reply-loss') {
      fixture.rpc.mockImplementationOnce(async (request) => {
        expect(
          requestOrcadManagedStopCancellation(request, request.version, request.authority.runtimeId)
        ).toMatchObject({ outcome: 'canceled' })
        throw new Error('Transport lost reply after host persistence')
      })
    } else {
      state.cleanupFailure = true
    }
    expect(await cancelInterruptedOrcadManagedStop(fixture.options)).toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(readOrcadCanceledStopReceipt(state.home, fixture.request)).toBe(true)
    expect(readFileSync(fixture.transactionPath, 'utf8')).toBe(original)
    expect(state.releases).toBe(0)
    const { request } = fixture
    expect(
      await requestOrcadManagedDecommission(
        { version: request.version, authority: request.authority },
        request.version,
        request.authority.runtimeId
      )
    ).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(fixture.retire).not.toHaveBeenCalled()
    state.cleanupFailure = false
    expect(await cancelInterruptedOrcadManagedStop(fixture.options)).toMatchObject({
      outcome: 'canceled'
    })
    expect(fixture.rpc.mock.calls[0][0]).toEqual(fixture.rpc.mock.calls[1][0])
    expect(state.releases).toBe(1)
    expect(existsSync(fixture.root)).toBe(false)
    expect(readFileSync(fixture.activationPath, 'utf8')).toBe(
      serializeOrcadActivationRecord(fixture.before)
    )
    expect(readOrcadCanceledStopReceipt(state.home, request)).toBe(true)
    expect(await cancelInterruptedOrcadManagedStop(fixture.options)).toEqual({ outcome: 'none' })
    expect(fixture.rpc).toHaveBeenCalledTimes(2)
  }
)

it('durably cancels before host dispatch and rejects the delayed destructive request', async () => {
  const fixture = prepare(false)
  expect(await cancelInterruptedOrcadManagedStop(fixture.options)).toMatchObject({
    outcome: 'canceled'
  })
  expect(readOrcadCanceledStopReceipt(state.home, fixture.request)).toBe(true)
  expect(state.releases).toBe(1)
  expect(readFileSync(fixture.activationPath, 'utf8')).toBe(
    serializeOrcadActivationRecord(fixture.before)
  )
  const { request } = fixture
  expect(
    await requestOrcadManagedDecommission(request, request.version, request.authority.runtimeId)
  ).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
  expect(fixture.retire).not.toHaveBeenCalled()
})
