import { expect, it } from 'vitest'
import { createAgySignInEvidence, type AgyEvidenceScope } from './agy-sign-in-evidence'

const START = Date.parse('2026-11-27T21:56:29Z')
const scope: AgyEvidenceScope = { method: 'oauth-personal', binary: '1024:1', loginGeneration: 0 }

function evidence() {
  let now = START
  const record = createAgySignInEvidence({ now: () => now })
  const at = (seconds: number) => {
    now = START + seconds * 1000
  }
  let id = 0
  const authRequired = (seconds: number, options: { clean?: boolean; id?: string; scope?: AgyEvidenceScope } = {}) => {
    at(seconds)
    record.observeAuthRequired({
      id: options.id ?? `check-${++id}`,
      scope: options.scope ?? scope,
      clean: options.clean ?? true
    })
  }
  return { record, at, authRequired }
}

it('confirms only two clean answers at least a minute apart', () => {
  const { record, authRequired } = evidence()
  authRequired(0)
  expect(record.confirmed(scope)).toBe(false)
  authRequired(59)
  expect(record.confirmed(scope)).toBe(false)
  authRequired(60)
  expect(record.confirmed(scope)).toBe(true)
})

it('pairs the newest answer with the oldest one still kept', () => {
  const { record, authRequired } = evidence()
  authRequired(0)
  authRequired(20)
  authRequired(61)
  expect(record.confirmed(scope)).toBe(true)
})

it('counts one answer that many callers shared as one', () => {
  const { record, authRequired } = evidence()
  authRequired(0, { id: 'flight-1' })
  authRequired(70, { id: 'flight-1' })
  expect(record.confirmed(scope)).toBe(false)
})

// Incident mechanism: the keychain stalls under load, agy falls back to its file store and says
// "sign in". An answer while Orca's own read of that store stalls says nothing about the login.
it('never counts an answer taken while Orca could not read the store itself', () => {
  const { record, authRequired } = evidence()
  authRequired(0, { clean: false })
  authRequired(90, { clean: false })
  expect(record.confirmed(scope)).toBe(false)
  authRequired(150)
  expect(record.confirmed(scope)).toBe(false)
})

it('forgets answers older than ten minutes', () => {
  const { record, authRequired } = evidence()
  authRequired(0)
  authRequired(601)
  expect(record.confirmed(scope)).toBe(false)
})

it('starts over after any success', () => {
  const { record, at, authRequired } = evidence()
  authRequired(0)
  at(30)
  record.observeSuccess(scope)
  authRequired(90)
  expect(record.confirmed(scope)).toBe(false)
})

it('keeps answers about another method, binary or login apart', () => {
  const { record, authRequired } = evidence()
  authRequired(0)
  for (const other of [
    { ...scope, method: 'oauth-business' as const },
    { ...scope, binary: '2048:2' },
    { ...scope, loginGeneration: 1 }
  ]) {
    authRequired(90, { scope: other })
    expect(record.confirmed(other)).toBe(false)
  }
})

it('starts over when cleared', () => {
  const { record, authRequired } = evidence()
  authRequired(0)
  record.clear()
  authRequired(90)
  expect(record.confirmed(scope)).toBe(false)
})
