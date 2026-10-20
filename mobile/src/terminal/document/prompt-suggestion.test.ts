// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { handleMsg } from './host-message-router'

const capture = readFileSync(
  join(__dirname, '../../../../src/main/runtime/__fixtures__/claude-prompt-suggestion.txt'),
  'utf8'
)
const write = (terminal: Terminal, text: string): Promise<void> =>
  new Promise((resolve) => terminal.write(text, resolve))

it('reads the captured Claude suggestion through the document bridge without writing input', async () => {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  const scope = createTerminalDocumentScope()
  const post = vi.fn()
  Object.assign(scope, { term: terminal, ready: true, postToHost: post })
  try {
    await write(terminal, capture)
    handleMsg(scope, { type: 'read-prompt-suggestion', requestId: 7 })
    expect(post).toHaveBeenLastCalledWith({
      type: 'prompt-suggestion',
      requestId: 7,
      text: 'yes, write tests for both'
    })
    await write(terminal, '\x1b[28;3H\x1b[0mMy draft\x1b[28;3H')
    handleMsg(scope, { type: 'read-prompt-suggestion', requestId: 8 })
    expect(post).toHaveBeenLastCalledWith({ type: 'prompt-suggestion', requestId: 8, text: null })
    await write(terminal, capture)
    scope.ready = false
    handleMsg(scope, { type: 'read-prompt-suggestion', requestId: 9 })
    expect(post).toHaveBeenLastCalledWith({ type: 'prompt-suggestion', requestId: 9, text: null })
  } finally {
    terminal.dispose()
  }
})
