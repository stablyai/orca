import { describe, expect, it } from 'vitest'
import advisorCapture from '../../shared/__fixtures__/claude-server-tools-2.1.318.json'
import { chat, chatTurn, prompt, reply } from './claude-transcript-catch-up-test-support'

describe('Claude server tool catch-up', () => {
  it.each(['assistant', 'user'] as const)(
    'imports server results from %s without opening a human turn',
    async (role) => {
      const c = await chat()
      await c.live()
      const call = reply(
        'server-call',
        'p2',
        'server-message',
        advisorCapture[0]!.message.content[0]!,
        4
      )
      const result = {
        ...reply(
          'server-result',
          'server-call',
          'server-message',
          advisorCapture[1]!.message.content[0]!,
          5
        ),
        type: role,
        message: { role, content: advisorCapture[1]!.message.content }
      }
      await c.write([
        ...chatTurn,
        prompt('p2', 'a1', 'ask advisor', 3),
        call,
        result,
        reply('answer', 'server-result', 'answer-message', { type: 'text', text: 'done' }, 6)
      ])
      expect(await c.open('a1')).toBe(true)
      const before = c.journal.snapshot()
      expect(c.rows()).toEqual([
        'user:ask 1',
        'assistant:answer 1',
        '(continued-outside)',
        'user:ask advisor',
        'tool:advisor:completed',
        'assistant:done'
      ])
      const tool = before.items.find((row) => row.body.kind === 'tool-call')
      expect(tool?.body).toMatchObject({
        kind: 'tool-call',
        name: 'advisor',
        state: 'completed',
        output: {
          head: '{"type":"advisor_redacted_result","encrypted_content":"redacted-advisor-content"}'
        }
      })
      expect(before.items.filter((row) => row.body.kind === 'turn')).toHaveLength(2)
      expect(tool?.turnScope).toEqual(
        before.items.find(
          (row) =>
            row.body.kind === 'message' &&
            row.body.role === 'assistant' &&
            row.itemId.endsWith(':block%3Aanswer-message%3A0')
        )?.turnScope
      )
      await c.journal.close()
      expect((await c.replay()).snapshot().items).toEqual(before.items)
    }
  )
})
