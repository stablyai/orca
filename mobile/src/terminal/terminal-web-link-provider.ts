import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { extractTerminalFileLinks } from '../../../src/shared/terminal-links'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'
import { resolveTerminalOscFileTap } from './terminal-file-url-tap'
import {
  createTerminalLiveOscLinkRanges,
  type RetainedTerminalOscLinkRange
} from './terminal-live-osc-link-ranges'
import { createTerminalWebLinkTapController } from './terminal-web-link-tap-controller'
import type { TerminalWebViewProps } from './terminal-webview-contract'
import {
  findTerminalFileUrls,
  findTerminalHttpUrls,
  type TerminalUrlMatch
} from './terminal-webview-url-tap'

type LinkControllerOptions = {
  container: HTMLElement
  terminal: Terminal
  getProps: () => TerminalWebViewProps
  cancelSelection: () => void
}

type TerminalWebLink = {
  text: string
  startIndex: number
  endIndex: number
  activate: () => void
}

type RetainedOscLink = TerminalOscLinkRange & {
  expectedText?: string
}

const MAX_LINKS_PER_LINE = 64

export function createTerminalWebLinkController({
  container,
  terminal,
  getProps,
  cancelSelection
}: LinkControllerOptions) {
  let initialOscLinks: RetainedOscLink[] = []
  let initialOscRowOffset = 0
  let replayingInitialData = false
  const liveOscLinks = createTerminalLiveOscLinkRanges(terminal)

  const provider = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const row = bufferLineNumber - 1
      const line = terminal.buffer.active.getLine(row)
      if (!line) {
        callback(undefined)
        return
      }
      const text = line.translateToString(true)
      const links = terminalWebLinksForLine(
        text,
        row,
        initialOscLinks,
        initialOscRowOffset,
        getProps,
        liveOscLinks.ranges()
      )
        .slice(0, MAX_LINKS_PER_LINE)
        .map((link) => terminalLinkForBufferLine(line, row, link))
        .filter((link): link is ILink => link !== null)
      callback(links.length > 0 ? links : undefined)
    }
  })
  const lineFeed = terminal.onLineFeed(() => {
    if (
      !replayingInitialData &&
      terminal.buffer.active.type === 'normal' &&
      terminal.buffer.normal.length >= (terminal.options.scrollback ?? 0) + terminal.rows
    ) {
      initialOscRowOffset += 1
      liveOscLinks.trimLeadingRow()
    }
  })
  const tapController = createTerminalWebLinkTapController({
    container,
    terminal,
    activateAtBufferCell: (row, column) =>
      activateTerminalWebLinkAtBufferCell(
        terminal,
        row,
        column,
        initialOscLinks,
        initialOscRowOffset,
        getProps,
        liveOscLinks.ranges()
      ),
    cancelSelection,
    onTerminalTap: () => getProps().onTerminalTap?.()
  })

  return {
    setInitialOscLinks(links: TerminalOscLinkRange[] | undefined) {
      initialOscLinks = links ? [...links] : []
      initialOscRowOffset = 0
      liveOscLinks.reset()
    },
    setInitialReplayPending(pending: boolean) {
      replayingInitialData = pending
      if (!pending) {
        initialOscLinks = initialOscLinks.map((link) => ({
          ...link,
          expectedText: terminal.buffer.active
            .getLine(link.row)
            ?.translateToString(false, link.startCol, link.endCol)
        }))
      }
    },
    dispose() {
      tapController.dispose()
      liveOscLinks.dispose()
      lineFeed.dispose()
      provider.dispose()
    }
  }
}

export function activateTerminalWebUri(uri: string, props: TerminalWebViewProps): void {
  if (/^https?:\/\//i.test(uri)) {
    props.onOpenUrl?.(uri)
    return
  }
  const file = resolveTerminalOscFileTap(uri)
  if (file) {
    props.onFileTap?.(file.pathText, file.line, file.column)
  }
}

export function terminalWebLinksForLine(
  lineText: string,
  row: number,
  initialOscLinks: RetainedOscLink[],
  initialOscRowOffset: number,
  getProps: () => TerminalWebViewProps,
  liveOscLinks: RetainedTerminalOscLinkRange[] = []
): TerminalWebLink[] {
  const links: TerminalWebLink[] = []
  for (const [retainedLinks, rowOffset] of [
    [initialOscLinks, initialOscRowOffset],
    [liveOscLinks, 0]
  ] as const) {
    for (const link of retainedLinks) {
      if (link.row - rowOffset !== row) {
        continue
      }
      const text = lineText.slice(link.startCol, link.endCol)
      if (!text || (link.expectedText !== undefined && link.expectedText !== text)) {
        continue
      }
      links.push({
        text,
        startIndex: link.startCol,
        endIndex: link.endCol,
        activate: () => activateTerminalWebUri(link.uri, getProps())
      })
    }
  }
  for (const match of findTerminalFileUrls(lineText)) {
    addNonOverlappingLink(links, match, () => activateTerminalWebUri(match.url, getProps()))
  }
  for (const match of findTerminalHttpUrls(lineText)) {
    addNonOverlappingLink(links, match, () => getProps().onOpenUrl?.(match.url))
  }
  for (const segment of unlinkedLineSegments(lineText, links)) {
    for (const match of extractTerminalFileLinks(segment.text)) {
      const startIndex = segment.startIndex + match.startIndex
      const endIndex = segment.startIndex + match.endIndex
      addNonOverlappingLink(
        links,
        {
          url: lineText.slice(startIndex, endIndex),
          startIndex,
          endIndex
        },
        () => getProps().onFileTap?.(match.pathText, match.line, match.column)
      )
    }
  }
  return links.sort((left, right) => left.startIndex - right.startIndex)
}

function unlinkedLineSegments(
  lineText: string,
  links: TerminalWebLink[]
): { text: string; startIndex: number }[] {
  const segments: { text: string; startIndex: number }[] = []
  let startIndex = 0
  for (const link of [...links].sort((left, right) => left.startIndex - right.startIndex)) {
    if (link.startIndex > startIndex) {
      segments.push({ text: lineText.slice(startIndex, link.startIndex), startIndex })
    }
    startIndex = Math.max(startIndex, link.endIndex)
  }
  if (startIndex < lineText.length) {
    segments.push({ text: lineText.slice(startIndex), startIndex })
  }
  return segments
}

function addNonOverlappingLink(
  links: TerminalWebLink[],
  match: TerminalUrlMatch,
  activate: () => void
): void {
  if (links.some((link) => match.startIndex < link.endIndex && match.endIndex > link.startIndex)) {
    return
  }
  links.push({
    text: match.url,
    startIndex: match.startIndex,
    endIndex: match.endIndex,
    activate
  })
}

function terminalLinkForBufferLine(
  line: IBufferLine,
  row: number,
  link: TerminalWebLink
): ILink | null {
  const startCol = bufferColumnForStringIndex(line, link.startIndex)
  const endCol = bufferColumnForStringIndex(line, link.endIndex)
  if (startCol === null || endCol === null || endCol <= startCol) {
    return null
  }
  return {
    text: link.text,
    range: {
      start: { x: startCol + 1, y: row + 1 },
      end: { x: endCol, y: row + 1 }
    },
    activate: link.activate
  }
}

export function bufferColumnForStringIndex(line: IBufferLine, index: number): number | null {
  if (!Number.isInteger(index) || index < 0) {
    return null
  }
  if (index === 0) {
    return 0
  }
  let remaining = index
  for (let col = 0; col < line.length; col += 1) {
    const cell = line.getCell(col)
    if (!cell || cell.getWidth() === 0) {
      continue
    }
    remaining -= cell.getChars().length || 1
    if (remaining < 0) {
      return col
    }
    if (remaining === 0) {
      return col + cell.getWidth()
    }
  }
  return remaining === 0 ? line.length : null
}

export function bufferStringIndexForColumn(line: IBufferLine, column: number): number {
  let stringIndex = 0
  for (let col = 0; col < Math.min(column, line.length); col += 1) {
    const cell = line.getCell(col)
    if (cell && cell.getWidth() > 0) {
      stringIndex += cell.getChars().length || 1
    }
  }
  return stringIndex
}

function activateTerminalWebLinkAtBufferCell(
  terminal: Terminal,
  row: number,
  column: number,
  initialOscLinks: RetainedOscLink[],
  initialOscRowOffset: number,
  getProps: () => TerminalWebViewProps,
  liveOscLinks: RetainedTerminalOscLinkRange[]
): boolean {
  const line = terminal.buffer.active.getLine(row)
  if (!line) {
    return false
  }
  const stringIndex = bufferStringIndexForColumn(line, column)
  const links = terminalWebLinksForLine(
    line.translateToString(true),
    row,
    initialOscLinks,
    initialOscRowOffset,
    getProps,
    liveOscLinks
  )
  const link = links.find(
    (candidate) => stringIndex >= candidate.startIndex && stringIndex < candidate.endIndex
  )
  link?.activate()
  return link !== undefined
}
