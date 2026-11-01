// Shared with real Windows .cmd round-trip tests so both parsers must preserve every argument.
export const WINDOWS_ARGUMENT_CORPUS: readonly { name: string; value: string }[] = [
  { name: 'plain', value: 'hello' },
  { name: 'empty', value: '' },
  { name: 'space', value: 'hello world' },
  { name: 'double-quote', value: 'say "hi" ok' },
  { name: 'quote-only', value: '"' },
  { name: 'two-quotes', value: '""' },
  { name: 'caret', value: 'a^b' },
  { name: 'ampersand', value: 'a&b' },
  { name: 'pipe', value: 'a|b' },
  { name: 'redirect', value: 'a<b>c' },
  { name: 'percent-pair', value: 'e%F%g' },
  // Inserted quotes after backslashes must not become CommandLineToArgvW escapes.
  { name: 'percent-after-backslash', value: 'C:\\Users\\%F%\\x' },
  { name: 'percent-after-two-backslashes', value: 'C:\\\\%F%' },
  { name: 'percent-lone', value: '100% done' },
  { name: 'bang', value: 'q!VAR!r' },
  { name: 'parens', value: 'a(b)c' },
  { name: 'trailing-backslash', value: 'C:\\dir\\' },
  { name: 'backslash-quote', value: 'a\\"b' },
  { name: 'double-backslash-quote', value: 'a\\\\"b' },
  { name: 'only-backslashes', value: '\\\\\\' },
  { name: 'semicolon-comma', value: 'a;b,c' },
  { name: 'unicode', value: '日本語 café' },
  { name: 'combined', value: 'x"y&z%F%' },
  { name: 'agent-prompt', value: 'Fix "src/a b.ts" & run tests 100% !now! ^ (v2)' }
]

// Defined variables expose accidental percent expansion instead of letting it pass silently.
export const WINDOWS_ARGUMENT_CORPUS_ENV: Readonly<Record<string, string>> = {
  F: 'EXPANDED_F',
  VAR: 'EXPANDED_VAR'
}
