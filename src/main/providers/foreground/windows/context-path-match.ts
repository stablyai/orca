import type { WindowsProcessRow } from './process-rows'

export function normalizeContextPaths(contextPaths: readonly string[] | undefined): string[] {
  const normalized = new Set<string>()
  for (const contextPath of contextPaths ?? []) {
    const candidate = normalizePathForCommandMatch(contextPath)
    if (isSafeContextPath(candidate)) {
      normalized.add(candidate)
    }
  }
  return [...normalized].sort((a, b) => b.length - a.length)
}

function isSafeContextPath(contextPath: string): boolean {
  return contextPath.length >= 4 && (/^[a-z]:\//.test(contextPath) || contextPath.startsWith('//'))
}

export function candidateMatchesContextPath(
  candidate: WindowsProcessRow,
  normalizedContextPaths: readonly string[]
): boolean {
  if (normalizedContextPaths.length === 0) {
    return false
  }
  const haystack = normalizePathForCommandMatch(candidate.command)
  return normalizedContextPaths.some((contextPath) =>
    commandLineContainsPath(haystack, contextPath)
  )
}

function normalizePathForCommandMatch(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase()
}

function commandLineContainsPath(haystack: string, contextPath: string): boolean {
  let index = haystack.indexOf(contextPath)
  while (index !== -1) {
    const before = index > 0 ? haystack[index - 1] : ''
    const after = haystack[index + contextPath.length] ?? ''
    const beforeOk = !before || /[\s"'(=]/.test(before)
    const afterOk = !after || after === '/' || /[\s"'),;]/.test(after)
    if (beforeOk && afterOk) {
      return true
    }
    index = haystack.indexOf(contextPath, index + 1)
  }
  return false
}
