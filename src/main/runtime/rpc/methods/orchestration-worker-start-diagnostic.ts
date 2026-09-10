type DiagnosticRedactionRule = {
  pattern: RegExp
  replace: (match: string) => string
}

const SECRET_DIAGNOSTIC_RULES: readonly DiagnosticRedactionRule[] = [
  {
    pattern:
      /\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi,
    replace: (match) => {
      const keyPrefix = match.match(/^(\S+?\s*[:=]\s*)/)?.[1] ?? ''
      return `${keyPrefix}[redacted]`
    }
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]+/gi, replace: () => 'Bearer [redacted]' },
  { pattern: /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g, replace: () => '[redacted]' },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replace: () => '[redacted]' }
]

const DIAGNOSTIC_MAX_LENGTH = 2000

export function boundedRedactedDiagnostic(rawMessage: string): string {
  let redacted = rawMessage
  for (const rule of SECRET_DIAGNOSTIC_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replace)
  }
  return redacted.length > DIAGNOSTIC_MAX_LENGTH
    ? `${redacted.slice(0, DIAGNOSTIC_MAX_LENGTH)}… [truncated ${redacted.length - DIAGNOSTIC_MAX_LENGTH} chars]`
    : redacted
}
