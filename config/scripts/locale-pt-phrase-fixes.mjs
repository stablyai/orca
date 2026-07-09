// Portuguese (pt-BR) phrase fixes for machine translation artifacts.
// Why: keep locale-phrase-fixes.mjs under max-lines.
export const PT_PHRASE_FIXES = [
  { pattern: /relações públicas/g, replacement: 'PR', whenEnMatches: /\bPRs?\b/ },
  { pattern: /\bcometer\b/g, replacement: 'fazer commit', whenEnIncludes: 'commit' },
  { pattern: /\bramo\b/g, replacement: 'branch', whenEnIncludes: 'ranch' },
  { pattern: /\bfundir\b/g, replacement: 'fazer merge', whenEnIncludes: 'merge' },
  { pattern: /\bquestão\b/g, replacement: 'issue', whenEnIncludes: 'issue' },
  { pattern: /\bestado\b/g, replacement: 'status', whenEnIncludes: 'Status' }
]
