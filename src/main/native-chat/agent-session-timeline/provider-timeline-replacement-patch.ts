// Plain -/+ replacement of the given lines, starting after skippedLines, with no diff run.
export function replacementHunk(oldText: string, newText: string, skippedLines = 0): string {
  const lines = (text: string, prefix: string): { count: number; text: string } => {
    if (!text) {
      return { count: 0, text: '' }
    }
    const entries = text.split('\n')
    if (entries.at(-1) === '') {
      entries.pop()
    }
    return {
      count: entries.length,
      text:
        entries.map((line) => `${prefix}${line}\n`).join('') +
        (text.endsWith('\n') ? '' : '\\ No newline at end of file\n')
    }
  }
  const oldLines = lines(oldText, '-')
  const newLines = lines(newText, '+')
  return `@@ -${(oldLines.count ? 1 : 0) + skippedLines},${oldLines.count} +${(newLines.count ? 1 : 0) + skippedLines},${newLines.count} @@\n${oldLines.text}${newLines.text}`
}

export function replacementPatch(
  path: string,
  oldText: string,
  newText: string,
  skippedLines = 0
): string {
  return `--- ${path}\n+++ ${path}\n${replacementHunk(oldText, newText, skippedLines)}`
}
