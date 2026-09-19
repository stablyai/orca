import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configureOrcadDecommission, requestOrcadManagedDecommission } from './orcad-decommission'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'
import {
  emptyOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from '../ssh/orcad-activation-record'
import {
  createOrcadDecommissionTransaction,
  serializeOrcadActivationTransaction
} from '../ssh/orcad-activation-transaction'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => state.home
}))

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'orcad-stop-isolation-'))
})
afterEach(() => {
  configureOrcadDecommission(null)
  rmSync(state.home, { recursive: true, force: true })
})

it('a same-version second profile cannot accept, adopt or reopen the first profile stop', async () => {
  const version = '0.1.0+same'
  const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
  const makeProfile = (name: string) => {
    const root = join(state.home, name)
    mkdirSync(root)
    return { runtimeId: `runtime-${name}`, profileId: name, profileRoot: realpathSync(root) }
  }
  const a = makeProfile('a')
  const b = makeProfile('b')
  const authority = { ...a, transactionId }
  const instance = {
    pid: 123,
    startedAtMs: null,
    nonce: 'original',
    lockPath: join(state.home, 'orcad.lock')
  }
  const controlRoot = join(state.home, '.orca-remote')
  const transactionRoot = join(controlRoot, '.orcad-activation-transaction')
  mkdirSync(transactionRoot, { recursive: true })
  const before = {
    ...emptyOrcadActivationRecord(),
    active: version,
    activatedAt: new Date(1).toISOString()
  }
  const accepted = withDecommissioningVersion(before, new Date(2))
  const transaction = createOrcadDecommissionTransaction({
    authority,
    instance,
    transactionId,
    activeVersion: version,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  })
  const activationPath = join(controlRoot, 'orcad-active.json')
  writeFileSync(activationPath, serializeOrcadActivationRecord(before))
  writeFileSync(
    join(transactionRoot, 'transaction.json'),
    serializeOrcadActivationTransaction(transaction)
  )

  const bAdmission = new PtyOwnershipTransferAdmissionRecord(b.profileRoot, b.runtimeId)
  const retireB = vi.fn(async (owner) => {
    bAdmission.close(owner)
    return { outcome: 'accepted' as const }
  })
  configureOrcadDecommission(retireB, b)
  await expect(
    requestOrcadManagedDecommission({ version, authority }, version, b.runtimeId)
  ).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
  await expect(
    requestOrcadManagedDecommission(
      { version, authority: { ...b, transactionId } },
      version,
      b.runtimeId
    )
  ).resolves.toMatchObject({
    outcome: 'refused',
    code: 'orcad_decommission_transaction_unverifiable'
  })
  expect(retireB).not.toHaveBeenCalled()
  expect(bAdmission.isClosed()).toBe(false)
  expect(readFileSync(activationPath, 'utf8')).toBe(serializeOrcadActivationRecord(before))

  const aAdmission = new PtyOwnershipTransferAdmissionRecord(a.profileRoot, a.runtimeId)
  configureOrcadDecommission(
    async (owner) => {
      aAdmission.close(owner)
      return { outcome: 'accepted' }
    },
    a,
    instance
  )
  await expect(
    requestOrcadManagedDecommission({ version, authority }, version, a.runtimeId)
  ).resolves.toEqual({ outcome: 'accepted', transactionId, authority })
  expect(readFileSync(activationPath, 'utf8')).toBe(serializeOrcadActivationRecord(accepted))

  configureOrcadDecommission(retireB, b)
  await expect(
    requestOrcadManagedDecommission({ version, authority }, version, b.runtimeId)
  ).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
  const restartedA = new PtyOwnershipTransferAdmissionRecord(a.profileRoot, a.runtimeId)
  expect(restartedA.isClosed()).toBe(true)
  expect(() => restartedA.reopenAfterConfirmedNativeRefusal({ ...b, transactionId })).toThrow()
  expect(new PtyOwnershipTransferAdmissionRecord(b.profileRoot, b.runtimeId).isClosed()).toBe(false)
  expect(retireB).not.toHaveBeenCalled()
})
