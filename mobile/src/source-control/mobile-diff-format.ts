import type { MobileDiffLine } from '../session/mobile-diff-lines'

export function mobileDiffLinePrefix(kind: MobileDiffLine['kind']): string {
  if (kind === 'add') {
    return '+'
  }
  if (kind === 'delete') {
    return '-'
  }
  return ' '
}

export function mobileDiffLineNumber(line: MobileDiffLine): string {
  return String(line.newLineNumber ?? line.oldLineNumber ?? '')
}
