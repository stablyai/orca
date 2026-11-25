export type PrCommentSeverity = 'critical' | 'major' | 'minor' | 'trivial'

const SEVERITY_BY_WORD: Record<string, PrCommentSeverity> = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  trivial: 'trivial',
  nitpick: 'trivial'
}

// No lookbehind: WebKit before Safari 16.4 cannot parse it, and the page would not load.
// Review bots (CodeRabbit and similar) open a finding with an emphasised severity, e.g. "_🟠 Major_" or "**Major**".
const SEVERITY_PATTERN =
  /(?:^|[^a-z0-9])(?:_|\*\*)(?:[^_*\n]{0,7}[^a-z_*\n])?(critical|major|minor|trivial|nitpick)(?![a-z])[^_*\n]{0,8}(?:_|\*\*)(?![a-z0-9])/i
const SEVERITY_HEAD_CHARS = 160

export function prCommentSeverity(body: string): PrCommentSeverity | null {
  const word = body.slice(0, SEVERITY_HEAD_CHARS).match(SEVERITY_PATTERN)?.[1]
  return word ? (SEVERITY_BY_WORD[word.toLowerCase()] ?? null) : null
}
