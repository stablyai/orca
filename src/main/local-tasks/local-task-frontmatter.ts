const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export type ParsedLocalTaskFile = { fields: Record<string, string>; body: string }

// Values may carry a trailing ` # comment`; quotes are stripped.
export function parseLocalTaskFile(text: string): ParsedLocalTaskFile {
  const match = FRONTMATTER.exec(text)
  if (!match) {
    return { fields: {}, body: text }
  }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0 || /^\s/.test(line)) {
      continue
    }
    const value = line
      .slice(colon + 1)
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
    fields[line.slice(0, colon).trim()] = value
  }
  return { fields, body: match[2] }
}

export function parseLocalTaskList(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export const DEFAULT_LOCAL_TASK_PRIORITY = 3

// Accepts `2` or `p2`; anything outside 1-5 falls back to the default.
export function parseLocalTaskPriority(value: string | undefined): number {
  const n = Number(value?.trim().replace(/^p/i, ''))
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : DEFAULT_LOCAL_TASK_PRIORITY
}
