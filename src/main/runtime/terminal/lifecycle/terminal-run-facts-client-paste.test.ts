import { expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from './terminal-run-facts'

it('keeps an edited or still-ingesting client paste unresolved until a safe submit', () => {
  vi.useFakeTimers()
  try {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pty-draft', 'driving', 'note')
    facts.recordClientPaste('pty-draft', 181_438)
    facts.recordInput('pty-draft', 'driving', 'edited')
    facts.recordInput('pty-draft', 'driving', '\r')
    expect(facts.readResolvedInputGeneration('pty-draft')).toBe(0)
    vi.advanceTimersByTime(250_000)
    facts.recordInput('pty-draft', 'driving', 'more editing')
    expect(facts.readResolvedInputGeneration('pty-draft')).toBe(0)
    facts.recordInput('pty-draft', 'driving', '\n')
    expect(facts.readResolvedInputGeneration('pty-draft')).toBe(0)
    facts.recordInput('pty-draft', 'driving', '\r')
    expect(facts.readResolvedInputGeneration('pty-draft')).not.toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
