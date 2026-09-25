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
    facts.recordUserInput('pty-1', 100)
    facts.recordUserInput('pty-1', 200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: true, firstUserInputAt: 100 })
  })

  it('starts a new process clean', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordUserInput('pty-1', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' }, { tabId: 'source-tab' })

    expect(facts.read('pty-1', 'inc-2')).toEqual({ freshSpawn: true, firstUserInputAt: null })
    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: false, firstUserInputAt: null })
  })

  it('never reads a reattached process as fresh', () => {
    const facts = new TerminalRunFactsRegister()

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1').freshSpawn).toBe(false)
  })
})
