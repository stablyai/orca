export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || isBlankBrowserUrl(trimmed)) {
    return 'about:blank'
  }
  if (hasHttpLikeLocalHost(trimmed)) {
    try {
      return new URL(`http://${trimmed}`).toString()
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'file:'
      ? parsed.toString()
      : null
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString()
    } catch {
      return null
    }
  }
}

export function displayBrowserUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  return isBlankBrowserUrl(trimmed) ? 'about:blank' : trimmed
}

export function isBlankBrowserUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? ''
  return !trimmed || trimmed === 'about:blank' || trimmed.startsWith('data:text/html')
}

function hasHttpLikeLocalHost(value: string): boolean {
  return (
    /^(localhost|127(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i.test(value) ||
    /^[\w.-]+\.local(?::\d+)?(?:[/?#].*)?$/i.test(value)
  )
}
