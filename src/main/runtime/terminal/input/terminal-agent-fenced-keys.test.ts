import { expect, it } from 'vitest'
import { writeFencedAgentKeys } from './terminal-agent-fenced-keys'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'

it('runs the fence at the real writer handoff, after the asynchronous check settles', async () => {
  const written: string[] = []
  const writer = new RuntimeTerminalWriter(
    () => false,
    undefined,
    undefined,
    (_ptyId, data) => {
      written.push(data)
      return { outcome: 'accepted' }
    }
  )
  const runtime = {
    sendTerminal: async (
      handle: string,
      action: { text?: string; enter?: boolean },
      options: Parameters<RuntimeTerminalWriter['writeAction']>[3]
    ) => {
      const settlement = await writer.writeAction('pty-1', action, action.text ?? '', options)
      return {
        handle,
        accepted: settlement?.outcome === 'accepted',
        bytesWritten: written.length,
        writeSettlement: settlement
      }
    }
  }
  let working = true
  const error = new Error('turn_ended')
  await expect(
    writeFencedAgentKeys(runtime, 'term-1', '\x1b', {
      signal: new AbortController().signal,
      beforeWrite: async () => {
        queueMicrotask(() => {
          working = false
        })
      },
      fence: () => {
        if (!working) {
          throw error
        }
      }
    })
  ).resolves.toEqual({ outcome: 'refused', error })
  expect(written).toEqual([])
})
