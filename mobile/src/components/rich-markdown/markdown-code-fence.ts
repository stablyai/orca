// Choose fence longer than every contained backtick run; fixed triple fence would turn inner code into paragraphs. Reader preserves chosen opening width.

/** Longer than the longest backtick run inside, and never under three. */
export function codeFenceFor(code: string): string {
  let longest = 0
  let longRun: RegExp | undefined
  let start = code.indexOf('`')
  while (start !== -1) {
    let end = start + 1
    if (code.charCodeAt(end) === 96) {
      longRun ??= /`+/y
      longRun.lastIndex = end
      if (longRun.test(code)) {
        end = longRun.lastIndex
      }
    }
    longest = Math.max(longest, end - start)
    start = code.indexOf('`', end)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The run a line opens a block with, and the language it names, or null when it opens none. */
export function openingFence(line: string): { fence: string; language: string } | null {
  const match = line.match(/^(`{3,})([^\s`]*)\s*$/)
  return match ? { fence: match[1]!, language: match[2] ?? '' } : null
}

/** Only a bare run at least as long as the opening one closes the block it opened. */
export function closesFence(line: string, fence: string): boolean {
  const match = line.match(/^(`{3,})\s*$/)
  return match !== null && match[1]!.length >= fence.length
}
