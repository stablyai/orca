// Git strips ASCII whitespace only: a branch may end in, say, a no-break space.
const isGitSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13

export function trimGitSpace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isGitSpace(text.charCodeAt(start))) {
    start += 1
  }
  while (end > start && isGitSpace(text.charCodeAt(end - 1))) {
    end -= 1
  }
  return text.slice(start, end)
}

// Git reads `ref:` followed by any whitespace; spell it one way.
export function normalizeHead(text: string): string {
  const trimmed = trimGitSpace(text)
  const target = trimmed.startsWith('ref:') ? trimGitSpace(trimmed.slice('ref:'.length)) : ''
  return target && !/[ \t\n\r]/.test(target) ? `ref: ${target}` : trimmed
}

export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
