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

it('a host that cannot name the process keeps releasing on any admitted agent', () => {
  const evidence = new MailboxForegroundEvidence()
  const probe = () => evidence.captureForegroundObservation('pty-1', 'incarnation-1')
  evidence.applyForeground('pty-1', { ...probe(), process: suspended }, 'agent', true)
  evidence.applyForeground('pty-1', probe(), 'shell')
  expect(evidence.applyForeground('pty-1', probe(), 'agent', true)).toBe(true)
  expect(evidence.foregroundHold('pty-1')).toBeUndefined()
})
