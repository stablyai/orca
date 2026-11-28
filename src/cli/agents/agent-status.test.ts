import { expect, it } from 'vitest'
import { agentStatusExitCode, agentStatusLine, type AgentStatusResult } from './agent-status'

const checkedAt = Date.parse('2026-11-27T21:56:29Z')

const unknown = (
  reason: string,
  checkedWith: 'keychain' | 'credential_file' | 'probe'
): AgentStatusResult => ({
  agent: 'antigravity',
  readiness: { state: 'unknown', reason, checkedWith, checkAgainAfterMs: 60_000, checkedAt }
})

it('says a ready agent is ready and exits 0', () => {
  const result: AgentStatusResult = {
    agent: 'antigravity',
    readiness: { state: 'ready', evidence: 'probe', checkedAt }
  }
  expect(agentStatusLine(result, checkedAt)).toBe('Antigravity is ready (checked just now).')
  expect(agentStatusExitCode(result)).toBe(0)
})

it('gives the sign-in step for a confirmed sign-out and exits 3', () => {
  const result: AgentStatusResult = {
    agent: 'antigravity',
    readiness: {
      state: 'signed_out',
      evidence: 'store_absent',
      signInInstruction: 'agy',
      checkedAt
    }
  }
  expect(agentStatusLine(result, checkedAt)).toBe(
    "Antigravity isn't signed in on this computer. Run `agy` to sign in."
  )
  expect(agentStatusExitCode(result)).toBe(3)
})

// Incident replay: the keychain read timed out under load. Nobody should be asked to sign in.
it('says it cannot check yet, naming the keychain only for a keychain timeout, and exits 4', () => {
  const keychain = unknown('timeout', 'keychain')
  expect(agentStatusLine(keychain, checkedAt)).toBe(
    "Can’t check Antigravity sign-in right now (the keychain didn't answer). Don't sign in yet; check again in about a minute."
  )
  expect(agentStatusExitCode(keychain)).toBe(4)
})

it('names agy for an unanswered probe and never claims the keychain for a probe timeout', () => {
  expect(agentStatusLine(unknown('unanswered', 'probe'), checkedAt)).toBe(
    "Can’t check Antigravity sign-in right now (agy didn't answer). Don't sign in yet; check again in about a minute."
  )
  const probeTimeout = agentStatusLine(unknown('timeout', 'probe'), checkedAt)
  expect(probeTimeout).toBe(
    "Can’t check Antigravity sign-in right now (the check timed out). Don't sign in yet; check again in about a minute."
  )
  expect(probeTimeout).not.toMatch(/keychain/i)
})

it('says an unconfirmed sign-in ask is not confirmed yet', () => {
  expect(agentStatusLine(unknown('auth_required_unconfirmed', 'probe'), checkedAt)).toBe(
    'Can’t check Antigravity sign-in right now (agy asked for sign-in, but that isn’t confirmed yet). Don\'t sign in yet; check again in about a minute.'
  )
})
