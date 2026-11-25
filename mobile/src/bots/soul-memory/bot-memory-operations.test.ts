import { describe, expect, it } from 'vitest'
import { interpretBotMemoryEdit } from './bot-memory-operations'

const NO_FACT = 'Füge zuerst ein paar Wörter hinzu.'

describe('interpretBotMemoryEdit', () => {
  it("says in the owner's words why the host refused an add with no words", () => {
    expect(() =>
      interpretBotMemoryEdit(
        { id: 'r1', ok: false, error: { code: 'runtime_error', message: 'bot_memory_no_fact' } },
        NO_FACT
      )
    ).toThrow(new Error(NO_FACT))
  })

  it("keeps any other refusal's own words", () => {
    expect(() =>
      interpretBotMemoryEdit(
        {
          id: 'r1',
          ok: false,
          error: { code: 'runtime_error', message: 'MEMORY.md kept changing; try again.' }
        },
        NO_FACT
      )
    ).toThrow('MEMORY.md kept changing; try again.')
  })

  it('reads whether the fact was already in memory', () => {
    expect(
      interpretBotMemoryEdit({ id: 'r1', ok: true, result: { alreadyInMemory: true } }, NO_FACT)
    ).toEqual({ alreadyInMemory: true })
  })
})
