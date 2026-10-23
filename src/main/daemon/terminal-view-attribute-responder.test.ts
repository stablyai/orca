import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { PROGRAM_STATUS_QUERY_REPLY } from '../../shared/program-status/protocol'
import { installTerminalViewAttributeResponder } from './terminal-view-attribute-responder'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('installTerminalViewAttributeResponder', () => {
  it('answers OSC 7501 feature detection for a hidden pane, even before a theme push', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const replies: string[] = []
    installTerminalViewAttributeResponder({
      parser: terminal.parser,
      getBaseAttributes: () => null,
      emitReply: (reply) => replies.push(reply)
    })
    await write(terminal, '\x1b]7501;?\x1b\\\x1b]11;?\x1b\\')
    // Why no OSC 11 reply: without a renderer push the color queries stay silent by design.
    expect(replies).toEqual([PROGRAM_STATUS_QUERY_REPLY])
    terminal.dispose()
  })
})
