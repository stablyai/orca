import { describe, expect, it } from 'vitest'
import { TerminalRunFactsRegister } from './terminal-run-facts'

describe('terminal run facts', () => {
  it('keeps driving input before publication across the exact reserved commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pending', 'driving', 'x', 100)
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-1' })
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-1' })
    expect(facts.read('pending', 'inc-1').firstUserInputAt).toBe(100)
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-2' })
    facts.recordInput('pending', 'driving', 'x', 200)
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-2' })
    expect(facts.read('pending', 'inc-2').firstUserInputAt).toBe(200)
    facts.delete('pending')
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-3' })
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-3' })
    expect(facts.read('pending', 'inc-3').firstUserInputAt).toBeNull()
  })

  it('keeps the first user input across later input and a re-registration of the same process', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)
    facts.recordInput('pty-1', 'driving', 'ls\r', 200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: true, firstUserInputAt: 100 })
  })

  it.each([
    ['a reattach', { isReattach: true }],
    ['an adoption', { agentSessionEnsure: { disposition: 'adopted' } }]
  ])('keeps the input of the running process through %s without an incarnation', (_l, commit) => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1' })
    facts.recordInput('pty-1', 'driving', 'next prompt\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', ...commit })

    expect(facts.read('pty-1', null)).toEqual({ freshSpawn: false, firstUserInputAt: 100 })
    expect(facts.readLastInputAt('pty-1')).toBe(100)
  })

  it('starts clean when a reattach names a different process than the one recorded', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2', isReattach: true })

    expect(facts.read('pty-1', 'inc-2')).toEqual({ freshSpawn: false, firstUserInputAt: null })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
  })

  it('records the last input, a launch write included, but no terminal reply', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)
    facts.recordInput('pty-1', 'launch', 'next task\r', 200)
    facts.recordInput('pty-1', 'query-reply', 'answer', 300)
    facts.recordInput('pty-1', 'driving', '\x1b[I', 400)

    expect(facts.read('pty-1', 'inc-1').firstUserInputAt).toBe(100)
    expect(facts.readLastInputAt('pty-1')).toBe(200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })
    expect(facts.readLastInputAt('pty-1')).toBe(200)
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
  })
})
