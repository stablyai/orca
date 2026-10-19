import assert from 'node:assert/strict'
import test from 'node:test'
import { relayLoadResumeSummary } from './relay-load-resume-phone.mjs'

test('summarizes resume latency from completed steps and failures by reason', () => {
  const summary = relayLoadResumeSummary([
    { ok: true, acceptMs: 100, confirmMs: 20, rttMs: 10 },
    { ok: true, acceptMs: 300, confirmMs: 40, rttMs: 10 },
    { ok: false, acceptMs: 200, confirmMs: 900, confirmFailure: 'database_unavailable' },
    { ok: false, failure: 'hello-4503' },
    { ok: false, failure: 'hello-4503' }
  ])

  assert.deepEqual(summary, {
    attempts: 5,
    ok: 2,
    acceptMsP50: 200,
    acceptMsP95: 300,
    confirmMsP50: 40,
    confirmMsP95: 40,
    rttMsP50: 10,
    failures: { 'confirm-database_unavailable': 1, 'hello-4503': 2 }
  })
})
