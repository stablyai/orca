import { expect, it } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { writeTerminalSendForReceipt } from './terminal-send-receipt'

it('lets pending host work run before handing a large guarded paste to the PTY', async () => {
  const order: string[] = []
  const writer = new RuntimeTerminalWriter(
    () => true,
    () => 'darwin',
    () => 'antigravity'
  )
  const text = 'synthetic note\n'.repeat(80_000)
  setImmediate(() => order.push('host work'))
  const receipt = await writeTerminalSendForReceipt(
    {
      writer,
      runFacts: {
        recordClientPaste() {},
        trackOwnInput: () => ({ generation: () => 7, beforeWrite() {}, afterWrite() {} })
      },
      writeAction: async () => {
        order.push('paste')
        return undefined
      }
    },
    {
      handle: 'term',
      ptyId: 'pty',
      action: { text },
      payload: text,
      options: { clientSubmit: true, inputKind: 'driving' }
    }
  )
  expect(receipt.accepted).toBe(true)
  expect(order).toEqual(['host work', 'paste'])
})
