// OSC 8 metadata used to disappear from hidden-terminal snapshots while its styling survived.
import './xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

type TerminalHarness = { terminal: Terminal; addon: SerializeAddon }
type OscLinkData = { id?: string; uri: string }

function createTerminal(): TerminalHarness {
  const terminal = new Terminal({ cols: 80, rows: 5, scrollback: 100, allowProposedApi: true })
  const addon = new SerializeAddon()
  terminal.loadAddon(addon)
  return { terminal, addon }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

async function replay(data: string): Promise<Terminal> {
  const { terminal } = createTerminal()
  await write(terminal, data)
  return terminal
}

function oscLinkAt(terminal: Terminal, row: number, col: number): OscLinkData | null {
  const cell = terminal.buffer.active.getLine(row)?.getCell(col) as
    | { extended?: { urlId?: number } }
    | undefined
  const linkId = cell?.extended?.urlId ?? 0
  if (!linkId) {
    return null
  }
  const internals = terminal as unknown as {
    _core?: { _oscLinkService?: { getLinkData: (id: number) => OscLinkData | undefined } }
  }
  return internals._core?._oscLinkService?.getLinkData(linkId) ?? null
}

describe('OSC 8 hyperlink snapshot round-trip', () => {
  it('retains a closed link URI without linking surrounding text', async () => {
    const url = 'https://github.com/stablyai/orca/issues/12345'
    const { terminal, addon } = createTerminal()
    await write(terminal, `before \x1b]8;;${url}\x1b\\#12345\x1b]8;;\x1b\\ after`)

    const restored = await replay(addon.serialize())
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('before #12345 after')
    expect(oscLinkAt(restored, 0, 6)).toBeNull()
    expect(oscLinkAt(restored, 0, 7)?.uri).toBe(url)
    expect(oscLinkAt(restored, 0, 12)?.uri).toBe(url)
    expect(oscLinkAt(restored, 0, 13)).toBeNull()
  })

  it('keeps an open link active for output arriving after replay', async () => {
    const url = 'https://example.com/streaming-link'
    const { terminal, addon } = createTerminal()
    await write(terminal, `\x1b]8;id=stream;${url}\x1b\\linked`)

    const restored = await replay(addon.serialize())
    await write(restored, 'Z\x1b]8;;\x1b\\')
    expect(oscLinkAt(restored, 0, 6)).toEqual({ id: 'stream', uri: url })
  })

  it('does not leak an open alternate-screen link into its unlinked prefix', async () => {
    const url = 'https://example.com/alternate'
    const { terminal, addon } = createTerminal()
    await write(terminal, `normal\x1b[?1049h\x1b[Hprefix \x1b]8;id=alternate;${url}\x1b\\linked`)

    const restored = await replay(addon.serialize())
    expect(restored.buffer.active.type).toBe('alternate')
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('prefix linked')
    expect(oscLinkAt(restored, 0, 0)).toBeNull()
    expect(oscLinkAt(restored, 0, 7)).toEqual({ id: 'alternate', uri: url })
    await write(restored, 'Z\x1b]8;;\x1b\\')
    expect(oscLinkAt(restored, 0, 13)).toEqual({ id: 'alternate', uri: url })
  })
})
