import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { QuotaFallbackLedger, type QuotaFallbackClaim } from './quota-fallback-ledger'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-quota-'))
  directories.push(directory)
  return { directory, ledger: new QuotaFallbackLedger(directory) }
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})
const claim: QuotaFallbackClaim = {
  operationId: 'session:turn:generation',
  sessionId: 'session',
  route: 'claude-api',
  pool: 'account',
  maxDebitUsd: 2,
  remainingUsd: 3
}
it('does not replay after a process restart or uncertain dispatch', () => {
  const { ledger, directory } = fixture()
  expect(ledger.claim(claim)).toBe('claimed')
  ledger.settle(claim.operationId, 'unknown')
  expect(new QuotaFallbackLedger(directory).claim(claim)).toBe('duplicate')
  expect(ledger.claim({ ...claim, operationId: 'other' })).toBe('sessionBusy')
})
it('reserves shared credit across sessions, retaining completed maximum cost conservatively', () => {
  const { ledger } = fixture()
  expect(ledger.claim(claim)).toBe('claimed')
  ledger.settle(claim.operationId, 'completed')
  expect(ledger.claim({ ...claim, operationId: 'next', sessionId: 'second' })).toBe('budgetHeld')
})
it('blocks on an unreconciled crashed writer lock', () => {
  const { ledger, directory } = fixture()
  mkdirSync(join(directory, 'lock'))
  expect(() => ledger.claim(claim)).toThrow()
})
it('does not reset a corrupt ledger or missing operation', () => {
  const { ledger, directory } = fixture()
  expect(() => ledger.settle('missing', 'completed')).toThrow()
  writeFileSync(join(directory, 'ledger.json'), 'corrupt')
  expect(() => ledger.claim(claim)).toThrow()
})
it('does not admit unlimited API reservations', () => {
  const { ledger } = fixture()
  for (const maxDebitUsd of [0, -1, Infinity, Number.NaN]) {
    expect(() => ledger.claim({ ...claim, maxDebitUsd })).toThrow()
  }
})
