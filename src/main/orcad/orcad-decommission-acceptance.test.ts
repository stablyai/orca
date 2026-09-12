import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
import {
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from '../ssh/orcad-activation-record'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  createOrcadDecommissionTransaction,
  serializeOrcadActivationTransaction
} from '../ssh/orcad-activation-transaction'
import {
  persistOrcadDecommissionAcceptance,
  validateOrcadDecommissionCancellation,
  validateOrcadDecommissionCompletion,
  validateOrcadDecommissionTransaction
} from './orcad-decommission-acceptance'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'
import { runProcess } from '../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { dirname } from 'node:path'
import { parseManagedStopOrcadCompletion } from '../ssh/orcad-managed-stop-process-command'
import { persistOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { persistOrcadCanceledStopReceipt } from './orcad-canceled-stop-receipt'
import {
  ORCAD_COMPLETED_STOP_RECEIPT_FILENAME,
  parseOrcadCompletedStopReceipt
} from '../ssh/orcad-completed-stop-receipt'

const VERSION = '0.2.0+new'
const TRANSACTION_ID = 'b407cda3-44bd-44d8-b75a-8268c18035b1'
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(bound = false) {
  const home = mkdtempSync(join(tmpdir(), 'orcad-decommission-'))
  roots.push(home)
  const controlRoot = join(home, '.orca-remote')
  const transactionRoot = join(controlRoot, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
  mkdirSync(transactionRoot, { recursive: true })
  const profileRoot = join(home, 'profile-a')
  if (bound) {
    mkdirSync(profileRoot)
  }
  const recordBefore = {
    ...emptyOrcadActivationRecord(),
    active: VERSION,
    activatedAt: new Date(1).toISOString()
  }
  const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2))
  const transaction = createOrcadDecommissionTransaction({
    transactionId: TRANSACTION_ID,
    ...(bound
      ? {
          authority: {
            runtimeId: 'runtime-a',
            profileId: 'profile-a',
            profileRoot: realpathSync(profileRoot),
            transactionId: TRANSACTION_ID
          }
        }
      : {}),
    activeVersion: VERSION,
    recordBefore,
    acceptedRecord,
    recordAfter: withDeactivatedVersion(acceptedRecord),
    now: new Date(2)
  })
  const activationPath = join(controlRoot, 'orcad-active.json')
  writeFileSync(activationPath, serializeOrcadActivationRecord(recordBefore), { mode: 0o600 })
  writeFileSync(
    join(transactionRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME),
    serializeOrcadActivationTransaction(transaction),
    { mode: 0o600 }
  )
  return {
    home,
    activationPath,
    acceptedRecord,
    transaction,
    transactionPath: join(transactionRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME)
  }
}

describe('host-owned orcad decommission acceptance', () => {
  it('allows cancellation validation only for the exact prepared instance and unchanged activation', () => {
    const { home, transaction, transactionPath, activationPath } = fixture(true)
    const authority = transaction.authority!
    const instance = {
      pid: 123,
      startedAtMs: null,
      nonce: 'original',
      lockPath: join(home, 'lock')
    }
    const validate = () => validateOrcadDecommissionCancellation(authority, VERSION, instance, home)
    expect(validate).toThrow('cancellation_unverifiable')
    const prepared = { ...transaction, instance }
    writeFileSync(transactionPath, serializeOrcadActivationTransaction(prepared))
    expect(validate).not.toThrow()
    expect(() =>
      validateOrcadDecommissionCancellation(
        authority,
        VERSION,
        { ...instance, nonce: 'replacement' },
        home
      )
    ).toThrow('cancellation_unverifiable')
    for (const phase of ['admission-fenced', 'process-exited'] as const) {
      writeFileSync(transactionPath, serializeOrcadActivationTransaction({ ...prepared, phase }))
      expect(validate).toThrow('cancellation_unverifiable')
    }
    writeFileSync(transactionPath, serializeOrcadActivationTransaction(prepared))
    writeFileSync(activationPath, serializeOrcadActivationRecord(transaction.acceptedRecord))
    expect(validate).toThrow('cancellation_unverifiable')
    writeFileSync(activationPath, serializeOrcadActivationRecord(transaction.recordBefore))
    persistOrcadCanceledStopReceipt(home, {
      schemaVersion: 1,
      version: VERSION,
      authority,
      instance
    })
    expect(validate).not.toThrow()
    expect(() =>
      validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home, undefined, authority)
    ).toThrow('stop_canceled')
  })

  it('rejects canceled transactions before acceptance or completion, including legacy replay', () => {
    const { home, transaction } = fixture(true)
    const authority = transaction.authority!
    const instance = {
      pid: 123,
      startedAtMs: null,
      nonce: 'original',
      lockPath: join(home, 'lock')
    }
    persistOrcadCanceledStopReceipt(home, {
      schemaVersion: 1,
      version: VERSION,
      authority,
      instance
    })
    expect(() =>
      validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home, undefined, authority)
    ).toThrow('stop_canceled')
    expect(() =>
      persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
    ).toThrow('stop_canceled')
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home, instance)).toThrow(
      'stop_canceled'
    )
    expect(() => validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home)).toThrow(
      'stop_canceled'
    )
  })

  it('archives exact completion outside cleanup and reflushes readable receipts', () => {
    const { home, transaction, transactionPath } = fixture(true)
    const authority = transaction.authority!
    const instance = {
      pid: 123,
      startedAtMs: null,
      nonce: 'original',
      lockPath: join(home, 'lock')
    }
    writeFileSync(
      transactionPath,
      serializeOrcadActivationTransaction({ ...transaction, instance })
    )
    new PtyOwnershipTransferAdmissionRecord(authority.profileRoot, authority.runtimeId).close(
      authority
    )
    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
    const request = { schemaVersion: 1 as const, version: VERSION, authority, instance }
    const archive = join(home, '.orca-remote', ORCAD_COMPLETED_STOP_RECEIPT_FILENAME)
    persistOrcadCompletedStopReceipt(request, home)
    const parsed = parseOrcadCompletedStopReceipt(readFileSync(archive, 'utf8'))
    expect(parsed).toMatchObject({
      state: 'ok',
      transaction: {
        authority,
        instance,
        phase: 'process-exited',
        recordAfter: transaction.recordAfter
      }
    })
    vi.mocked(fs.fsyncSync).mockClear()
    persistOrcadCompletedStopReceipt(request, home)
    expect(fs.fsyncSync).toHaveBeenCalled()
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error('archive fsync failed')
    })
    expect(() => persistOrcadCompletedStopReceipt(request, home)).toThrow('archive fsync failed')
    rmSync(transactionPath)
    expect(parseOrcadCompletedStopReceipt(readFileSync(archive, 'utf8')).state).toBe('ok')
  })

  it.each(['accepted', 'deactivated'])(
    'revalidates a completed %s checkpoint without reopening mutation',
    (state) => {
      const { home, transaction, transactionPath, activationPath } = fixture(true)
      const authority = transaction.authority!
      const instance = {
        pid: 123,
        startedAtMs: null,
        nonce: 'original',
        lockPath: join(home, 'lock')
      }
      const completed = { ...transaction, instance, phase: 'process-exited' as const }
      writeFileSync(transactionPath, serializeOrcadActivationTransaction(completed))
      writeFileSync(
        activationPath,
        serializeOrcadActivationRecord(
          state === 'accepted' ? transaction.acceptedRecord : transaction.recordAfter
        )
      )
      new PtyOwnershipTransferAdmissionRecord(authority.profileRoot, authority.runtimeId).close(
        authority
      )
      expect(validateOrcadDecommissionCompletion(authority, VERSION, home, instance)).toBe(
        'process-exited'
      )
      expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home)).toThrow(
        'original instance'
      )
      expect(() =>
        validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home, undefined, authority)
      ).toThrow('already records process exit')
      expect(() =>
        persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
      ).toThrow('already records process exit')
    }
  )

  it('refuses deactivation without a completed transaction checkpoint', () => {
    const { home, transaction, activationPath } = fixture(true)
    writeFileSync(activationPath, serializeOrcadActivationRecord(transaction.recordAfter))
    expect(() =>
      validateOrcadDecommissionCompletion(transaction.authority!, VERSION, home)
    ).toThrow('activation record changed')
  })

  it.skipIf(!process.env.ORCA_TEST_ORCAD_ENTRY)(
    'verifies durable completion in the packaged Bun process',
    async () => {
      const entry = process.env.ORCA_TEST_ORCAD_ENTRY!
      const runtime = join(dirname(entry), orcadBunRuntimeFilename(process.platform))
      const child = await runProcess({
        program: runtime,
        args: ['-e', 'process.stdout.write(String(process.pid))']
      })
      expect(child.code).toBe(0)
      const { home, transaction, transactionPath, activationPath } = fixture(true)
      const instance = {
        pid: Number(child.stdout),
        startedAtMs: null,
        nonce: 'completed-instance',
        lockPath: join(home, 'orcad.lock')
      }
      writeFileSync(
        transactionPath,
        serializeOrcadActivationTransaction({ ...transaction, instance })
      )
      const authority = transaction.authority!
      new PtyOwnershipTransferAdmissionRecord(authority.profileRoot, authority.runtimeId).close(
        authority
      )
      persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
      const request = { schemaVersion: 1 as const, version: VERSION, authority, instance }
      const result = await runProcess({
        program: runtime,
        args: [entry, '--complete-managed-stop', JSON.stringify(request), home]
      })
      expect(result.code, result.stderr).toBe(0)
      expect(parseManagedStopOrcadCompletion(result.stdout, request)).toBe('exited')
      writeFileSync(
        transactionPath,
        serializeOrcadActivationTransaction({ ...transaction, instance, phase: 'process-exited' })
      )
      for (const record of [transaction.acceptedRecord, transaction.recordAfter]) {
        writeFileSync(activationPath, serializeOrcadActivationRecord(record))
        const resumed = await runProcess({
          program: runtime,
          args: [entry, '--complete-managed-stop', JSON.stringify(request), home]
        })
        expect(resumed.code, resumed.stderr).toBe(0)
        expect(parseManagedStopOrcadCompletion(resumed.stdout, request)).toBe('exited')
      }
      const archived = readFileSync(
        join(home, '.orca-remote', ORCAD_COMPLETED_STOP_RECEIPT_FILENAME),
        'utf8'
      )
      rmSync(transactionPath)
      const receipt = parseOrcadCompletedStopReceipt(archived)
      if (receipt.state !== 'ok') {
        throw new Error('Completed stop archive missing after transaction cleanup')
      }
      writeFileSync(transactionPath, serializeOrcadActivationTransaction(receipt.transaction))
      const retried = await runProcess({
        program: runtime,
        args: [entry, '--complete-managed-stop', JSON.stringify(request), home]
      })
      expect(retried.code, retried.stderr).toBe(0)
      expect(parseManagedStopOrcadCompletion(retried.stdout, request)).toBe('exited')
    }
  )

  it('requires the durable original instance when completion names a process', () => {
    const { home, transaction, transactionPath } = fixture(true)
    const authority = transaction.authority!
    const instance = { pid: 123, startedAtMs: 456, nonce: 'original', lockPath: join(home, 'lock') }
    new PtyOwnershipTransferAdmissionRecord(authority.profileRoot, authority.runtimeId).close(
      authority
    )
    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home, instance)).toThrow(
      'instance does not match'
    )
    writeFileSync(
      transactionPath,
      serializeOrcadActivationTransaction({ ...transaction, instance })
    )
    expect(() =>
      validateOrcadDecommissionCompletion(authority, VERSION, home, instance)
    ).not.toThrow()
    for (const changed of [
      { ...instance, pid: 124 },
      { ...instance, startedAtMs: null },
      { ...instance, nonce: 'replacement' },
      { ...instance, lockPath: join(home, 'other-lock') }
    ]) {
      expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home, changed)).toThrow(
        'instance does not match'
      )
    }
  })
  it('requires both durable acceptance and the exact closed profile fence before process stop', () => {
    const { home, transaction } = fixture(true)
    const authority = transaction.authority!
    const record = new PtyOwnershipTransferAdmissionRecord(
      authority.profileRoot,
      authority.runtimeId
    )
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home)).toThrow(
      'no durable acceptance'
    )
    record.close(authority)
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home)).toThrow(
      'no durable acceptance'
    )
    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, undefined, authority)
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home)).not.toThrow()
    record.reopenAfterConfirmedNativeRefusal(authority)
    expect(() => validateOrcadDecommissionCompletion(authority, VERSION, home)).toThrow(
      'closure_unverifiable'
    )
  })

  it('requires exact running authority before accepting an identity-bound transaction', () => {
    const { home, activationPath, transaction, acceptedRecord } = fixture(true)
    const before = readFileSync(activationPath, 'utf8')
    expect(() => validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home)).toThrow(
      'authority does not match'
    )
    for (const field of ['runtimeId', 'profileId', 'profileRoot', 'transactionId'] as const) {
      expect(() =>
        validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home, undefined, {
          ...transaction.authority!,
          [field]: 'wrong-owner'
        })
      ).toThrow('authority does not match')
    }
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
    const { transactionSnapshot } = validateOrcadDecommissionTransaction(
      TRANSACTION_ID,
      VERSION,
      home,
      undefined,
      transaction.authority
    )
    persistOrcadDecommissionAcceptance(
      TRANSACTION_ID,
      VERSION,
      home,
      transactionSnapshot,
      transaction.authority
    )
    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: acceptedRecord
    })
  })

  it('cannot retrospectively assign authority to a legacy stop transaction', () => {
    const { home } = fixture()
    expect(() =>
      validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home, undefined, {
        runtimeId: 'runtime-a',
        profileId: 'profile-a',
        profileRoot: home,
        transactionId: TRANSACTION_ID
      })
    ).toThrow('authority does not match')
  })

  it('prevalidates without publishing acceptance and rechecks before publishing', () => {
    const { home, activationPath, acceptedRecord, transaction } = fixture()
    const before = readFileSync(activationPath, 'utf8')
    const validated = validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home)
    expect(validated).toEqual({
      activationPath,
      acceptedRecord,
      phase: 'prepared',
      recordAfter: transaction.recordAfter,
      recordBefore: transaction.recordBefore,
      transactionSnapshot: expect.any(String)
    })
    expect(JSON.parse(validated.transactionSnapshot)).toEqual(transaction)
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
    writeFileSync(activationPath, serializeOrcadActivationRecord(emptyOrcadActivationRecord()))
    expect(() => persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)).toThrow(
      'changed during decommission'
    )
    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: emptyOrcadActivationRecord()
    })
  })

  it('rejects a changed transaction even when its ID and active version still match', () => {
    const { home, activationPath, transaction, transactionPath } = fixture()
    const { transactionSnapshot } = validateOrcadDecommissionTransaction(
      TRANSACTION_ID,
      VERSION,
      home
    )
    const before = readFileSync(activationPath, 'utf8')
    writeFileSync(
      transactionPath,
      serializeOrcadActivationTransaction({
        ...transaction,
        acceptedRecord: withDecommissioningVersion(transaction.recordBefore, new Date(3))
      })
    )
    expect(() =>
      persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home, transactionSnapshot)
    ).toThrow('transaction changed')
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
  })

  it('does not authorize fencing a runtime after the transaction records process exit', () => {
    const { home, activationPath, transaction, transactionPath } = fixture()
    const before = readFileSync(activationPath, 'utf8')
    writeFileSync(
      transactionPath,
      serializeOrcadActivationTransaction({ ...transaction, phase: 'process-exited' })
    )
    expect(() => validateOrcadDecommissionTransaction(TRANSACTION_ID, VERSION, home)).toThrow(
      'already records process exit'
    )
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32').each([1, 2])(
    'reflushes acceptance after an uncertain durability operation (%s)',
    async (failureAt) => {
      const { home, activationPath, acceptedRecord } = fixture()
      const flush = (await vi.importActual<typeof fs>('node:fs')).fsyncSync
      let calls = 0
      const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        flush(fd)
        if (++calls === failureAt) {
          throw Object.assign(new Error('uncertain flush'), { code: 'EIO' })
        }
      })
      expect(() => persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)).toThrow(
        'uncertain flush'
      )
      const beforeRetry = sync.mock.calls.length
      persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)
      expect(sync.mock.calls.length).toBe(beforeRetry + 2)
      expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
        state: 'ok',
        record: acceptedRecord
      })
    }
  )

  it('durably publishes the exact accepted record before acknowledging the RPC', () => {
    const { home, activationPath, acceptedRecord } = fixture()

    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)
    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)

    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: acceptedRecord
    })
  })

  it('refuses a receipt for a different transaction', () => {
    const { home, activationPath } = fixture()
    const before = readFileSync(activationPath, 'utf8')

    expect(() =>
      persistOrcadDecommissionAcceptance('9b677c21-e307-4e2e-a60a-9d4f807019b1', VERSION, home)
    ).toThrow('does not match')
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
  })

  it('refuses to overwrite a third activation record', () => {
    const { home, activationPath } = fixture()
    const changed = {
      ...emptyOrcadActivationRecord(),
      active: '0.3.0+other',
      activatedAt: new Date(3).toISOString()
    }
    writeFileSync(activationPath, serializeOrcadActivationRecord(changed))

    expect(() => persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)).toThrow(
      'changed during decommission'
    )
    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: changed
    })
  })
})
