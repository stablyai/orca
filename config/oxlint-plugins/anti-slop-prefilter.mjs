// Returning false before traversal avoids deserializing the JS AST when all rules skip.
import antiSlop from '../../.anti-slop-plugin/index.ts'

// Escaped identifiers and computed string keys can hide required text.
const hasEscape = (text) => text.includes('\\')

const REQUIRED_TEXT = {
  'no-module-mocking': (text) => /mock/i.test(text),
  'no-object-parameters': (text) => text.includes('object'),
  'no-reduce-accumulator-copy': (text) => text.includes('reduce'),
  'no-reflect-apply': (text) => text.includes('Reflect'),
  'no-reflect-get': (text) => text.includes('Reflect'),
  'no-unknown-type-aliases': (text) => text.includes('unknown') && /\btype\b/.test(text),
  'no-widen-then-assert': (text) => /\b(?:unknown|any|object)\b/.test(text) && /\bas\b|</.test(text)
}

function withPrefilter(rule, mayMatch) {
  return {
    meta: rule.meta,
    createOnce(context) {
      const { before, ...visitor } = rule.createOnce(context)
      return {
        ...visitor,
        before() {
          const text = context.sourceCode.text
          if (!mayMatch(text) && !hasEscape(text)) {
            return false
          }
          return before?.()
        }
      }
    }
  }
}

export default {
  meta: antiSlop.meta,
  rules: Object.fromEntries(
    Object.entries(antiSlop.rules).map(([name, rule]) => [
      name,
      REQUIRED_TEXT[name] ? withPrefilter(rule, REQUIRED_TEXT[name]) : rule
    ])
  )
}
