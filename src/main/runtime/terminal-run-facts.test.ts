import { describe, expect, it } from 'vitest'
import { TerminalRunFactsRegister } from './terminal-run-facts'

describe('terminal run facts', () => {
  it('reads a run main never saw committed as not fresh', () => {
    expect(new TerminalRunFactsRegister().read('pty-1', 'inc-1')).toEqual({
      freshSpawn: false,
      firstUserInputAt: null
    })
  })

  it('keeps the first user input across later input and a re-registration of the same process', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)
    facts.recordInput('pty-1', 'driving', 'ls\r', 200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: true, firstUserInputAt: 100 })
  })

  it('starts a new process clean', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' }, { tabId: 'source-tab' })

    expect(facts.read('pty-1', 'inc-2')).toEqual({ freshSpawn: true, firstUserInputAt: null })
    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: false, firstUserInputAt: null })
  })

  it('never reads a reattached process as fresh', () => {
    const facts = new TerminalRunFactsRegister()

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1').freshSpawn).toBe(false)
  })

  it('starts clean when a new process commits without an incarnation', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1' })

    expect(facts.read('pty-1', null)).toEqual({ freshSpawn: true, firstUserInputAt: null })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
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

  it('keeps input recorded before main adopted the process with its first commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pty-1', 'driving', 'next prompt\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

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

  it.each([
    ['a launch write', 'launch', 'echo startup\r'],
    ['a query reply', 'query-reply', '\x1b[1;1R'],
    ['driving bytes that are only a terminal reply', 'driving', '\x1b[1;1R'],
    ['driving bytes that are only focus reports', 'driving', '\x1b[I\x1b[O']
  ] as const)('records nothing for %s', (_label, inputKind, data) => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })

    facts.recordInput('pty-1', inputKind, data, 100)

    expect(facts.read('pty-1', 'inc-1').firstUserInputAt).toBeNull()
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

  it('records the last input on a PTY main adopted without a spawn commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pty-1', 'driving', 'next task\r', 100)

    expect(facts.readLastInputAt('pty-1')).toBe(100)
    expect(facts.read('pty-1', null).firstUserInputAt).toBeNull()
  })

  it('evicts run facts when deleted', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.delete('pty-1')

    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: false, firstUserInputAt: null })
  })
})
