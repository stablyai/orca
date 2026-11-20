import { expect, it } from 'vitest'
import { MailboxForegroundEvidence } from './mailbox-foreground-evidence'

const suspended = { pid: 4242, startedAtMs: 1_795_000_000_000 }
const newcomer = { pid: 4242, startedAtMs: 1_795_000_600_000 }

it('held mail waits for the suspended agent itself, not a new agent of the same kind', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')

  expect(evidence.applyForeground('pty-1', { ...probe(), process: suspended }, 'agent', true)).toBe(
    true
  )
  expect(evidence.applyForeground('pty-1', probe(), 'shell')).toBe(true)
  expect(evidence.foregroundHold('pty-1')).toBe('incarnation-1')

  expect(evidence.applyForeground('pty-1', { ...probe(), process: newcomer }, 'agent', true)).toBe(
    false
  )
  expect(evidence.foregroundHold('pty-1')).toBe('incarnation-1')

  expect(evidence.applyForeground('pty-1', { ...probe(), process: suspended }, 'agent', true)).toBe(
    true
  )
  expect(evidence.foregroundHold('pty-1')).toBeUndefined()
})

it('a host that never names the process releases on any admitted agent', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  evidence.applyForeground('pty-1', probe(), 'agent', true)
  evidence.applyForeground('pty-1', probe(), 'shell')
  expect(evidence.applyForeground('pty-1', probe(), 'agent', true)).toBe(true)
  expect(evidence.foregroundHold('pty-1')).toBeUndefined()
})

it('once the agent is known, a probe that cannot name it keeps the hold', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  evidence.applyForeground('pty-1', { ...probe(), process: suspended }, 'agent', true)
  evidence.applyForeground('pty-1', probe(), 'shell')
  expect(evidence.applyForeground('pty-1', probe(), 'agent', true)).toBe(false)
  expect(evidence.foregroundHold('pty-1')).toBe('incarnation-1')
})

it('another known program in front holds mail like a shell does', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  expect(evidence.applyForeground('pty-1', probe(), 'non-shell')).toBe(true)
  expect(evidence.foregroundHold('pty-1')).toBe('incarnation-1')
})

it('a host that cannot name an agent never holds mail; a shell there only requires the screen again', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  expect(evidence.applyForeground('pty-1', { ...probe(), agentUnprovable: true }, 'shell')).toBe(
    true
  )
  expect(evidence.foregroundHold('pty-1')).toBeUndefined()
  expect(evidence.screenRecovery('pty-1')).toBe('incarnation-1')
})

it('a new agent resumed after the held agent exited is what held mail awaits', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  evidence.applyForeground('pty-1', { ...probe(), process: suspended }, 'agent', true)
  evidence.applyForeground('pty-1', probe(), 'shell')
  expect(
    evidence.applyForeground(
      'pty-1',
      { ...probe(), process: newcomer, heldAgentGone: true },
      'agent',
      true
    )
  ).toBe(true)
  expect(evidence.foregroundHold('pty-1')).toBeUndefined()
})
