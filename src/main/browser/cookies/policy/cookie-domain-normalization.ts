export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  const isBracketedIpv6 = candidate.startsWith('[') && candidate.endsWith(']')
  if (!candidate || /[/\\@?#%]/.test(candidate) || (!isBracketedIpv6 && candidate.includes(':'))) {
    return null
  }
  try {
    const parsed = new URL(`https://${candidate}/`)
    const normalized = parsed.hostname.toLowerCase()
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      normalized.endsWith('.') ||
      normalized.includes('..')
    ) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}
