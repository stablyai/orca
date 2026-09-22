import type { TerminalDocumentTerminal } from './document-terminal-shape'

/**
 * The engine, as the shape the seam promises rather than as a cast.
 *
 * Every member is here because the type names it; the ones the start sequence and `init` actually
 * reach do something, and the rest answer in the shape their caller would read. The two the
 * assertions want are handed back beside the terminal — where `open` was called, and how many
 * times `dispose` was — so the double itself carries nothing the shape does not declare.
 *
 * Shared, because a second reader of the same seam would otherwise restate thirty members and the
 * two doubles would drift as the shape grows.
 */
export function terminalDocumentDouble() {
  let openedOn: HTMLElement | undefined
  let disposals = 0
  const terminal: TerminalDocumentTerminal = {
    cols: 80,
    rows: 24,
    options: { theme: {}, minimumContrastRatio: 3, fontSize: 13 },
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'normal',
        getLine: () => undefined
      }
    },
    get element() {
      return openedOn
    },
    unicode: { activeVersion: '6' },
    write(_data: string, callback?: () => void) {
      callback?.()
    },
    open(element: HTMLElement) {
      openedOn = element
    },
    loadAddon() {},
    attachCustomKeyEventHandler() {},
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    clear() {},
    reset() {},
    refresh() {},
    resize() {},
    selectAll() {},
    select() {},
    clearSelection() {},
    scrollLines() {},
    scrollToLine() {},
    scrollToBottom() {},
    dispose() {
      disposals += 1
    }
  }
  return { terminal, openedOn: () => openedOn, disposals: () => disposals }
}
