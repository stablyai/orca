import { describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewProps } from './terminal-webview-contract'
import {
  activateTerminalWebUri,
  bufferColumnForStringIndex,
  bufferStringIndexForColumn,
  terminalWebLinksForLine
} from './terminal-web-link-provider'
import {
  completeTerminalWebLinkTap,
  isPrimaryTerminalWebLinkPointer
} from './terminal-web-link-tap-controller'

function lineFromCells(cells: { chars: string; width: number }[]) {
  return {
    length: cells.length,
    getCell: (col: number) => ({
      getChars: () => cells[col]?.chars ?? '',
      getWidth: () => cells[col]?.width ?? 1
    })
  } as Parameters<typeof bufferColumnForStringIndex>[0]
}

describe('hosted terminal link provider', () => {
  it('routes http, file URL, and path links through the existing callbacks', () => {
    const onOpenUrl = vi.fn()
    const onFileTap = vi.fn()
    const props = { onOpenUrl, onFileTap }
    const links = terminalWebLinksForLine(
      'https://example.com file:///tmp/a.ts#L4 src/b.ts:8:2',
      0,
      [],
      0,
      () => props
    )

    links.forEach((link) => link.activate())

    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com')
    expect(onFileTap).toHaveBeenCalledWith('/tmp/a.ts', 4, null)
    expect(onFileTap).toHaveBeenCalledWith('src/b.ts', 8, 2)
  })

  it('keeps a bare filename distinct from neighboring URL and path links', () => {
    const onOpenUrl = vi.fn()
    const onFileTap = vi.fn()
    const links = terminalWebLinksForLine(
      'SELECT_ME_COPY README.md https://example.com src/app.ts:12:3',
      0,
      [],
      0,
      () => ({ onOpenUrl, onFileTap })
    )

    links.forEach((link) => link.activate())

    expect(onFileTap).toHaveBeenCalledWith('README.md', null, null)
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com')
    expect(onFileTap).toHaveBeenCalledWith('src/app.ts', 12, 3)
  })

  it('gives retained OSC ranges priority over visible fallback matches', () => {
    const onOpenUrl = vi.fn()
    const links = terminalWebLinksForLine(
      'issue #123',
      7,
      [{ row: 7, startCol: 6, endCol: 10, uri: 'https://example.com/123' }],
      0,
      () => ({ onOpenUrl })
    )

    expect(links).toHaveLength(1)
    links[0]?.activate()
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/123')
  })

  it('gives live OSC ranges the same tap routing and stale-text protection', () => {
    const onOpenUrl = vi.fn()
    const liveLinks = [
      {
        row: 3,
        startCol: 0,
        endCol: 10,
        uri: 'https://example.com/live',
        expectedText: 'live issue'
      }
    ]
    const links = terminalWebLinksForLine('live issue', 3, [], 0, () => ({ onOpenUrl }), liveLinks)

    expect(links).toHaveLength(1)
    links[0]?.activate()
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/live')
    expect(
      terminalWebLinksForLine('overwritten', 3, [], 0, () => ({ onOpenUrl }), liveLinks)
    ).toEqual([])
  })

  it('drops retained OSC ranges after their rows leave the buffer', () => {
    expect(
      terminalWebLinksForLine(
        'wrong text',
        7,
        [{ row: 7, startCol: 0, endCol: 5, uri: 'https://example.com' }],
        1,
        () => ({})
      )
    ).toEqual([])
  })

  it('rejects an initial OSC range after its visible text is replaced', () => {
    expect(
      terminalWebLinksForLine(
        'issue #999',
        7,
        [
          {
            row: 7,
            startCol: 6,
            endCol: 10,
            uri: 'https://example.com/123',
            expectedText: '#123'
          }
        ],
        0,
        () => ({})
      )
    ).toEqual([])
  })

  it('maps UTF-16 string offsets onto wide xterm buffer cells', () => {
    const line = lineFromCells([
      { chars: 'a', width: 1 },
      { chars: '界', width: 2 },
      { chars: '', width: 0 },
      { chars: 'b', width: 1 }
    ])

    expect(bufferColumnForStringIndex(line, 0)).toBe(0)
    expect(bufferColumnForStringIndex(line, 1)).toBe(1)
    expect(bufferColumnForStringIndex(line, 2)).toBe(3)
    expect(bufferColumnForStringIndex(line, 3)).toBe(4)
    expect(bufferStringIndexForColumn(line, 1)).toBe(1)
    expect(bufferStringIndexForColumn(line, 3)).toBe(2)
    expect(bufferStringIndexForColumn(line, 4)).toBe(3)
  })

  it('rejects arbitrary OSC protocols while allowing host-resolved file targets', () => {
    const onOpenUrl = vi.fn()
    const onFileTap = vi.fn()
    const props: TerminalWebViewProps = { onOpenUrl, onFileTap }

    activateTerminalWebUri('javascript:alert(1)', props)
    activateTerminalWebUri('docs/README.md:5', props)

    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(onFileTap).toHaveBeenCalledWith('docs/README.md', 5, null)
  })

  it('opens a tapped link and intentionally clears an existing selection', () => {
    const activateLink = vi.fn(() => true)
    const cancelSelection = vi.fn()
    const onTerminalTap = vi.fn()

    expect(
      completeTerminalWebLinkTap({
        hasSelection: true,
        activateLink,
        cancelSelection,
        onTerminalTap
      })
    ).toBe(true)
    expect(cancelSelection).toHaveBeenCalledOnce()
    expect(onTerminalTap).not.toHaveBeenCalled()
  })

  it('uses a blank tap to leave selection mode before focusing the terminal', () => {
    const cancelSelection = vi.fn()
    const onTerminalTap = vi.fn()

    expect(
      completeTerminalWebLinkTap({
        hasSelection: true,
        activateLink: () => false,
        cancelSelection,
        onTerminalTap
      })
    ).toBe(false)
    expect(cancelSelection).toHaveBeenCalledOnce()
    expect(onTerminalTap).not.toHaveBeenCalled()
  })

  it('accepts WKWebView touch pointers without allowing secondary mouse buttons', () => {
    expect(isPrimaryTerminalWebLinkPointer({ pointerType: 'touch', button: -1 })).toBe(true)
    expect(isPrimaryTerminalWebLinkPointer({ pointerType: 'mouse', button: 0 })).toBe(true)
    expect(isPrimaryTerminalWebLinkPointer({ pointerType: 'mouse', button: 2 })).toBe(false)
  })
})
