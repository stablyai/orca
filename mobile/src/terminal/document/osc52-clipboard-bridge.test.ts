// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import { attachOsc52ClipboardBridge } from './osc52-clipboard-bridge'
import { resetTerminalDataReplyAuthority, resumeTerminalDataReplyAuthority } from './query-reply'

const terminals: Terminal[] = []

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
})

function fixture() {
  const posted: unknown[] = []
  const scope = createTerminalDocumentScope({ postToHost: (message) => posted.push(message) })
  const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
  terminals.push(term)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real xterm exposes the narrower document terminal API.
  attachOsc52ClipboardBridge(scope, term as unknown as NonNullable<TerminalDocumentScope['term']>)
  const write = async (data: string) => {
    await new Promise<void>((resolve) => term.write(data, resolve))
    // The handler coalesces a parse's copies into one post on the next microtask.
    await Promise.resolve()
  }
  return { scope, posted, write }
}

// What Claude Code 2.1.308 writes when `c` is pressed in its /btw panel.
const BTW_COPY = `\x1b]52;c;${Buffer.from('hello from btw').toString('base64')}\x07`

describe('OSC 52 in the mobile terminal document', () => {
  it('posts a live copy to native as clipboard text', async () => {
    const { scope, posted, write } = fixture()
    resumeTerminalDataReplyAuthority(scope)
    await write(BTW_COPY)
    expect(posted).toEqual([{ type: 'clipboard-write', text: 'hello from btw' }])
  })

  it('drops a copy parsed before the replay boundary', async () => {
    const { scope, posted, write } = fixture()
    resetTerminalDataReplyAuthority(scope)
    await write(BTW_COPY)
    expect(posted).toEqual([])
  })
})
