import {
  canonicalGenericRenderings,
  glossaryRules
} from '../../locale-catalog/locale-generic-ui-terms.mjs'
import {
  ENGLISH_ONLY_KEY_PREFIXES,
  NEVER_TRANSLATE_VALUES,
  repairTranslatedValue
} from '../../locale-catalog/locale-translation-policy.mjs'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

// Why: placeholders, code, markup, URLs and CLI invocations (orca terminal, git commit) keep English on purpose.
const EXEMPT_SPAN_RE =
  /\{\{[^}]*\}\}|\{[^}]*\}|`[^`]*`|<code>[\s\S]*?<\/code>|<[^>]*>|https?:\/\/\S+|\b(?:orca|git|gh|glab) [a-z][a-z-]*/g

// Multi-word product names (Claude Agent Teams, Azure Repos) contain glossary terms but stay Latin.
const PRODUCT_NAMES = [...NEVER_TRANSLATE_VALUES]
  .filter((name) => name.includes(' '))
  .sort((left, right) => right.length - left.length)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileRules(locale) {
  return glossaryRules(locale).map((rule) => ({
    ...rule,
    // Why: agent-browser, .agents/, repo/path, @agent and repo:query are identifiers; "Terminal:" is copy.
    termRe: new RegExp(
      `(?<![\\w./@#:-])(?:${rule.terms.map(escapeRegExp).join('|')})(?![\\w/@#-]|\\.\\w|:(?!\\s|$))`
    )
  }))
}

function readableCopy(value) {
  let copy = value.replace(EXEMPT_SPAN_RE, ' ')
  for (const name of PRODUCT_NAMES) {
    copy = copy.split(name).join(' ')
  }
  return copy
}

// Copy left in English (or in a rejected spelling) where the locale glossary settled a translation.
export function collectGlossaryViolations(localeEntries, locale) {
  const rules = compileRules(locale)
  if (rules.length === 0) {
    return []
  }
  const violations = []
  for (const [key, value] of localeEntries) {
    if (
      typeof value !== 'string' ||
      ENGLISH_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue
    }
    const copy = readableCopy(value)
    for (const rule of rules) {
      const found =
        copy.match(rule.termRe)?.[0] ?? rule.variants.find((variant) => copy.includes(variant))
      if (found) {
        violations.push({ key, found, rendering: rule.rendering, value })
      }
    }
  }
  return violations
}

function formatGlossaryViolations(violations) {
  return violations
    .map((entry) => `${entry.key}: ${entry.found} -> ${entry.rendering} (${entry.value})`)
    .join('\n')
}

// Check repair policy too: parity passed while repair rewrote translated generic terms into English (#12113).
export function collectGenericTermRegressions(enEntries, localeEntries, localeName) {
  const renderings = canonicalGenericRenderings(localeName)
  if (renderings.length === 0) {
    return []
  }

  const regressions = []
  for (const [key, enValue] of enEntries) {
    const localeValue = localeEntries.get(key)
    if (typeof enValue !== 'string' || typeof localeValue !== 'string') {
      continue
    }
    const repaired = repairTranslatedValue({ key, enValue, localeValue, locale: localeName })
    if (repaired === localeValue) {
      continue
    }
    // Why: {{agent}} is an interpolation name, not English copy the reader sees.
    const repairedCopy = repaired.replace(PLACEHOLDER_RE, '')
    for (const { form, terms } of renderings) {
      if (!localeValue.includes(form) || repaired.includes(form)) {
        continue
      }
      if (
        terms.some((term) => new RegExp(`(^|[^A-Za-z])${term}($|[^A-Za-z])`).test(repairedCopy))
      ) {
        regressions.push({ key, form, localeValue, repaired })
        break
      }
    }
  }
  return regressions
}

function formatGenericTermRegressions(regressions) {
  return regressions
    .map((entry) => `${entry.key}: ${entry.form} -> English (${entry.repaired})`)
    .join('\n')
}

export function reportGlossaryProblems(localeName, genericTermRegressions, glossaryViolations) {
  if (genericTermRegressions.length > 0) {
    console.error('')
    console.error(
      'repair-locale-catalog would rewrite these translated terms back to English.',
      'Treat the term as generic in config/scripts/locale-catalog/locale-generic-ui-terms.mjs',
      'instead of listing its translation as a mistranslation.'
    )
    console.error(formatGenericTermRegressions(genericTermRegressions.slice(0, 20)))
    if (genericTermRegressions.length > 20) {
      console.error(`...and ${genericTermRegressions.length - 20} more generic term regressions`)
    }
  }
  if (glossaryViolations.length > 0) {
    console.error('')
    console.error(
      `These values keep a term the ${localeName} glossary settled (config/scripts/locale-catalog/locale-generic-ui-terms.mjs) in English or a replaced spelling.`,
      'Use the glossary term, or add a real product name to NEVER_TRANSLATE_VALUES in locale-translation-policy.mjs.'
    )
    console.error(formatGlossaryViolations(glossaryViolations.slice(0, 20)))
    if (glossaryViolations.length > 20) {
      console.error(`...and ${glossaryViolations.length - 20} more glossary violations`)
    }
  }
}
