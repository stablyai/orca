// Basic markdown → ANSI for the read-only document view. Emits SGR directly
// (bold/dim/italic/underline/inverse are formatting, not color, so they render
// regardless of the no-color theme) — the viewport clips these lines ANSI-aware.
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const UNDER = '\x1b[4m'
const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'

/** Apply inline emphasis: **bold**, *italic*, `code`, [text](url). Each span
 *  resets afterwards, so spans don't bleed into the rest of the line. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, `${INVERSE} $1 ${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/__([^_]+)__/g, `${BOLD}$1${RESET}`)
    .replace(/\*([^*]+)\*/g, `${ITALIC}$1${RESET}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDER}$1${RESET}`)
}

function heading(line: string): string {
  const level = line.match(/^#+/)?.[0].length ?? 1
  const text = line.replace(/^#+\s*/, '')
  if (level === 1) {
    return `${BOLD}${UNDER}${text}${RESET}`
  }
  if (level === 2) {
    return `${BOLD}${text}${RESET}`
  }
  return `${BOLD}${DIM}${text}${RESET}`
}

/** Render markdown source into styled screen lines (one per source line). */
export function renderMarkdown(source: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of source.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      out.push(`${DIM}${raw}${RESET}`)
      continue
    }
    if (inFence) {
      out.push(`${DIM}${raw}${RESET}`)
      continue
    }
    if (/^#{1,6}\s/.test(raw)) {
      out.push(heading(raw))
    } else if (/^\s*([-*+]|\d+\.)\s/.test(raw)) {
      const indent = raw.match(/^\s*/)?.[0] ?? ''
      const body = raw.replace(/^\s*([-*+]|\d+\.)\s+/, '')
      out.push(`${indent}• ${inline(body)}`)
    } else if (/^\s*>\s?/.test(raw)) {
      out.push(`${DIM}│ ${inline(raw.replace(/^\s*>\s?/, ''))}${RESET}`)
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      out.push('─'.repeat(80))
    } else {
      out.push(inline(raw))
    }
  }
  return out
}
