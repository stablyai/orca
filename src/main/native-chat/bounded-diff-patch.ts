import { createPatch } from 'diff'

// Whole-file replacement avoids expensive diffs for large unrelated files.
function replacementPatch(path: string, oldText: string, newText: string): string {
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
  return `--- ${path}\n+++ ${path}\n@@ -${oldLines.count ? 1 : 0},${oldLines.count} +${newLines.count ? 1 : 0},${newLines.count} @@\n${oldLines.text}${newLines.text}`
}

export function boundedDiffPatch(path: string, oldText: string, newText: string): string {
  const patch =
    oldText.length + newText.length <= 256 * 1024
      ? createPatch(path, oldText, newText, undefined, undefined, { maxEditLength: 1024 })
      : undefined
  return patch ?? replacementPatch(path, oldText, newText)
}
