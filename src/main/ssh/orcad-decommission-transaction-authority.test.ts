import { describe, expect, it } from 'vitest'
import {
  createOrcadDecommissionTransaction,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  withOrcadDecommissionPhase
} from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from './orcad-activation-record'

const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
const authority = {
  runtimeId: 'runtime-a',
  profileId: 'profile-a',
  profileRoot: '/host/profiles/profile-a',
  transactionId
}
const instance = {
  pid: 123,
  startedAtMs: 456,
  nonce: 'original-process',
  lockPath: '/host/orcad.lock'
}

function prepared(bound = true) {
  const before = {
    ...emptyOrcadActivationRecord(),
    active: '0.1.0+old',
    activatedAt: new Date(1).toISOString()
  }
  const accepted = withDecommissioningVersion(before, new Date(2))
  return createOrcadDecommissionTransaction({
    transactionId,
    ...(bound ? { authority } : {}),
    activeVersion: before.active,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  })
}

describe('identity-bound managed-stop transaction storage', () => {
  it.each(['prepared', 'admission-fenced', 'process-exited'] as const)(
    'retains the original instance through %s and serialization',
    (phase) => {
      const input = { ...instance }
      let transaction = createOrcadDecommissionTransaction({
        ...prepared(),
        instance: input,
        now: new Date(3)
      })
      input.nonce = 'replacement'
      if (phase !== 'prepared') {
        transaction = withOrcadDecommissionPhase(transaction, phase, new Date(4))
      }
      expect(transaction.instance).toEqual(instance)
      expect(
        parseOrcadActivationTransaction(serializeOrcadActivationTransaction(transaction))
      ).toEqual({ state: 'ok', transaction })
    }
  )

  it('keeps older bound transactions readable without inventing an instance', () => {
    const parsed = parseOrcadActivationTransaction(serializeOrcadActivationTransaction(prepared()))
    expect(parsed).toMatchObject({ state: 'ok', transaction: { schemaVersion: 2, authority } })
    if (parsed.state === 'ok') {
      expect(parsed.transaction).not.toHaveProperty('instance')
    }
  })

  it.each([
    { schemaVersion: 1 },
    { schemaVersion: 1, authority: undefined },
    { authority: undefined },
    { instance: { ...instance, pid: 0 } },
    { instance: { ...instance, nonce: '' } }
  ])('refuses invalid or authorityless instance records (%#)', (change) => {
    expect(
      parseOrcadActivationTransaction(JSON.stringify({ ...prepared(), instance, ...change }))
    ).toMatchObject({ state: 'unreadable' })
  })

  it('refuses to create authorityless instance records', () => {
    expect(() =>
      createOrcadDecommissionTransaction({ ...prepared(false), instance, now: new Date(3) })
    ).toThrow('instance requires authority')
  })
  it('does not attach new authority to an existing decommission marker', () => {
    const transaction = prepared()
    expect(() =>
      createOrcadDecommissionTransaction({
        ...transaction,
        recordBefore: transaction.acceptedRecord,
        now: new Date(3)
      })
    ).toThrow('cannot adopt an earlier')
    expect(
      parseOrcadActivationTransaction(
        JSON.stringify({
          ...transaction,
          recordBefore: transaction.acceptedRecord
        })
      )
    ).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('cannot adopt an earlier')
    })
  })

  it.each(['prepared', 'admission-fenced', 'process-exited'] as const)(
    'retains exact authority at the %s checkpoint',
    (phase) => {
      const transaction =
        phase === 'prepared'
          ? prepared()
          : withOrcadDecommissionPhase(prepared(), phase, new Date(3))
      expect(transaction.schemaVersion).toBe(2)
      expect(transaction.authority).toEqual(authority)
      expect(
        parseOrcadActivationTransaction(serializeOrcadActivationTransaction(transaction))
      ).toEqual({ state: 'ok', transaction })
    }
  )

  it('preserves legacy records without manufacturing authority', () => {
    const transaction = prepared(false)
    expect(transaction.schemaVersion).toBe(1)
    expect(transaction.authority).toBeUndefined()
    expect(
      parseOrcadActivationTransaction(serializeOrcadActivationTransaction(transaction))
    ).toEqual({ state: 'ok', transaction })
  })

  it.each([
    { schemaVersion: 1 },
    { authority: undefined },
    { authority: { ...authority, transactionId: 'b407cda3-44bd-44d8-b75a-8268c18035b1' } },
    { authority: { ...authority, runtimeId: '' } },
    { authority: { ...authority, profileId: '' } },
    { authority: { ...authority, profileRoot: '' } },
    { schemaVersion: 3 }
  ])('rejects invalid or downgraded authority: %j', (change) => {
    expect(
      parseOrcadActivationTransaction(JSON.stringify({ ...prepared(), ...change }))
    ).toMatchObject({ state: 'unreadable' })
  })

  it('refuses to create a transaction with authority from a different operation', () => {
    const transaction = prepared()
    expect(() =>
      createOrcadDecommissionTransaction({
        ...transaction,
        authority: { ...authority, transactionId: 'b407cda3-44bd-44d8-b75a-8268c18035b1' },
        now: new Date(3)
      })
    ).toThrow('transaction ID mismatch')
  })
})
