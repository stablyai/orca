import { expect, it } from 'vitest'
import { reserveEmptyTerminalDraft } from './terminal-empty-draft-reservation'
import { TerminalRunFactsRegister } from '../../../terminal/lifecycle/terminal-run-facts'
import { RuntimeTerminalWriter } from '../../../terminal/input/runtime-terminal-writer'
import { WRITE_ACCEPTED } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

it.each(['before-paste', 'before-enter', 'none'])(
  "never submits another client's draft (%s)",
  async (race) => {
    const facts = new TerminalRunFactsRegister()
    const reserve = await reserveEmptyTerminalDraft(
      {
        terminalRunFacts: facts,
        getTerminalPromptRequestBinding: () => ({
          ptyId: 'pty',
          processIncarnation: 'process',
          generation: 1
        }),
        readTerminal: async () => ({ source: 'screen' })
      },
      'terminal'
    )
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter(
      () => true,
      () => 'darwin',
      () => null,
      (_ptyId, data, kind) => {
        facts.recordInput('pty', kind, data, 10)
        writes.push(data)
        if (race === 'before-enter') {
          facts.recordInput('pty', 'driving', 'other draft', 10)
        }
        return WRITE_ACCEPTED
      },
      async () => true
    )
    if (race === 'before-paste') {
      facts.recordInput('pty', 'driving', 'other draft', 10)
    }
    const send = writer.writeAction('pty', { text: 'reply', enter: true }, 'reply\r', {
      inputKind: 'driving',
      requireWriteSettlement: true,
      reserveWrite: reserve
    })
    if (race === 'before-paste') {
      await expect(send).rejects.toThrow('terminal_reply_draft_changed')
      expect(writes).toEqual([])
    } else {
      const outcome = await send
      expect(writes).toEqual(race === 'none' ? ['reply', '\r'] : ['reply'])
      expect(outcome?.outcome).toBe(race === 'none' ? 'accepted' : 'unverifiable')
    }
  }
)

it('refuses a screen-unavailable snapshot instead of treating its omitted draft as empty', async () => {
  await expect(
    reserveEmptyTerminalDraft(
      {
        terminalRunFacts: new TerminalRunFactsRegister(),
        getTerminalPromptRequestBinding: () => ({
          ptyId: 'pty',
          processIncarnation: 'process',
          generation: 1
        }),
        readTerminal: async () => ({ source: 'screen-unavailable' })
      },
      'terminal'
    )
  ).rejects.toThrow('terminal_reply_draft_changed')
})
