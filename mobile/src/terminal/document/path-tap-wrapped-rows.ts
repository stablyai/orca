export type TerminalWrappedLineRow = { text: string; isWrapped?: boolean }

export type WrappedRowSlice = {
  content: string
  contentStart: number
  contentEnd: number
  visualEnd: number
  leadingToken: string
  trailingToken: string
  stoppedBeforeBoxBorder: boolean
}

function visualColumnWidth(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) ?? 0
    if (code > 0xffff) {
      i += 1
    }
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1
  }
  return width
}

function trimLeadingBeforeDrivePrefix(token: string): string {
  const driveMatch = /(?:^|[^A-Za-z])([A-Za-z]:(?:[\\/][\s\S]*|$))/.exec(token)
  if (!driveMatch) {
    return token
  }
  const driveToken = driveMatch[1]!
  return token.slice(token.length - driveToken.length)
}

export function sliceWrappedRow(text: string): WrappedRowSlice {
  const contentStart = (/^[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*/.exec(text) ?? [''])[0].length
  const rightTrim = (/[ \t]*[│┃║╎╏┆┇┊┋|]?[ \t]*$/.exec(text) ?? [''])[0].length
  const contentEnd = Math.max(contentStart, text.length - rightTrim)
  const content = text.slice(contentStart, contentEnd)
  const leadingToken = (/^[\p{L}\p{N}\p{M}._~\-/%+@:\\#()[\]\u30FB\uFF65\u301C\uFF5E]+/u.exec(
    content
  ) ?? [''])[0]
  const rawTrailing = (/[\p{L}\p{N}\p{M}._~\-/%+@:\\#()[\]\u30FB\uFF65\u301C\uFF5E]+$/u.exec(
    content
  ) ?? [''])[0]
  const trailingToken = trimLeadingBeforeDrivePrefix(rawTrailing)
  const stoppedBeforeBoxBorder = /[ \t]{3,}[│┃║╎╏┆┇┊┋|][ \t]*$/.test(text)
  return {
    content,
    contentStart,
    contentEnd,
    visualEnd: visualColumnWidth(text.slice(0, contentEnd)),
    leadingToken,
    trailingToken,
    stoppedBeforeBoxBorder
  }
}

export function isFullRowPathToken(slice: WrappedRowSlice): boolean {
  return slice.leadingToken.length > 0 && slice.leadingToken.length === slice.content.length
}

export function collapseRepeatedTrailingFilename(pathText: string): string {
  const lastSep = Math.max(pathText.lastIndexOf('/'), pathText.lastIndexOf('\\'))
  const basename = pathText.slice(lastSep + 1)
  if (basename.length >= 4 && basename.length % 2 === 0) {
    const half = basename.slice(0, basename.length / 2)
    if (basename.slice(basename.length / 2) === half && /\.[A-Za-z0-9_+-]+$/.test(half)) {
      return pathText.slice(0, lastSep + 1) + half
    }
  }
  const partialMatch = /^(.+\.[A-Za-z0-9_+-]{1,8})([^.\\/]+)$/u.exec(basename)
  if (partialMatch) {
    const stemWithExt = partialMatch[1]!
    const trailingRepeat = partialMatch[2]!
    if (trailingRepeat.length >= 2 && stemWithExt.startsWith(trailingRepeat)) {
      return pathText.slice(0, lastSep + 1) + stemWithExt
    }
  }
  return pathText
}

function canRowStartWrappedPath(slice: WrappedRowSlice): boolean {
  return (
    Boolean(slice.trailingToken) &&
    (slice.trailingToken.length === slice.content.length ||
      /[\\/_-]|^[A-Za-z]:$/.test(slice.trailingToken))
  )
}

function hasReachedWrapWidth(
  prev: WrappedRowSlice,
  next: WrappedRowSlice,
  terminalCols?: number
): boolean {
  if (prev.visualEnd < 12 || prev.stoppedBeforeBoxBorder) {
    return false
  }
  if (/[\\/\-.:]$/.test(prev.trailingToken) || /^[\\/]/.test(next.leadingToken)) {
    return true
  }
  const nextBreakIndex = next.leadingToken.indexOf('-')
  const hasPathContinuationToken =
    /[\\/]/.test(prev.trailingToken) && /\.[A-Za-z0-9_+-]+/.test(next.leadingToken)
  const wrapSlack = hasPathContinuationToken
    ? visualColumnWidth(next.leadingToken)
    : /[\\/\-.]$/.test(prev.trailingToken)
      ? nextBreakIndex !== -1
        ? nextBreakIndex + 1
        : next.leadingToken.length
      : 0
  const minWrapWidth = terminalCols && terminalCols < 35 ? Math.max(12, terminalCols - 1) : 35
  if (prev.visualEnd + wrapSlack < minWrapWidth) {
    return false
  }
  if (!terminalCols || terminalCols <= 35 || hasPathContinuationToken) {
    return true
  }
  return prev.visualEnd + wrapSlack >= Math.max(35, terminalCols - 8)
}

export function canRowContinueWrappedPath(
  prev: WrappedRowSlice,
  next: WrappedRowSlice,
  terminalCols?: number
): boolean {
  if (
    !hasReachedWrapWidth(prev, next, terminalCols) ||
    !canRowStartWrappedPath(prev) ||
    !next.leadingToken ||
    (next.leadingToken === '-' &&
      (next.content.length === 1 || /\s/.test(next.content.charAt(1)))) ||
    /^(?:~[\\/]|\/{2}|\\\\|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(next.leadingToken) ||
    (prev.trailingToken.length < prev.content.length &&
      !/[\\/]|^[A-Za-z]:$/.test(prev.trailingToken) &&
      (/[\\/]/.test(next.leadingToken) || !/\.[A-Za-z0-9]/.test(next.leadingToken)))
  ) {
    return false
  }
  if (
    /\.[A-Za-z0-9_+-]+(?::\d+)*$/.test(prev.trailingToken) &&
    !/[\\/]\.[A-Za-z0-9_+-]+$/.test(prev.trailingToken)
  ) {
    return (
      /^(?::\d+(?:-\d+)?(?::\d+)?|#(?:L|line-?)\d+)/i.test(next.leadingToken) ||
      (/:\d+$/.test(prev.trailingToken) && /^\d+(?:-\d+)?(?::\d+)?$/.test(next.leadingToken)) ||
      (/\.[a-z0-9]{1,2}$/.test(prev.trailingToken) &&
        /^[a-z0-9]{1,4}(?::\d+)*$/.test(next.leadingToken))
    )
  }
  if (
    !/[\\/.:#]/.test(next.leadingToken) &&
    !/[\\/\-.:]$/.test(prev.trailingToken) &&
    /^[A-Z][a-z]+$/.test(next.leadingToken)
  ) {
    return false
  }
  return true
}
