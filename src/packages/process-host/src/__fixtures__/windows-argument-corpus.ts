/**
 * Adversarial argument corpus for the Windows command-line encoding.
 *
 * Every entry round-trips through a real `.cmd` shim on Windows 11 with the
 * encoding in windows-command-line.ts. They are shared between the pure unit
 * test (which asserts the encoded bytes) and the Windows integration test
 * (which asserts what the child process actually receives), so a fix that only
 * satisfies one parser cannot pass.
 *
 * The `%`, `&` and `"` cases are the ones that shipped as bugs: an argument
 * containing `&` was truncated AND its remainder executed as a command.
 */
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
  // The shape that broke: a backslash immediately before a percent. Quoting
  // inserts a quote there, and a quote after a single backslash is an escaped
  // quote to CommandLineToArgvW.
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

/**
 * Environment the Windows integration test must run with, so the `%VAR%` cases
 * fail loudly instead of passing by accident against an undefined variable.
 */
export const WINDOWS_ARGUMENT_CORPUS_ENV: Readonly<Record<string, string>> = {
  F: 'EXPANDED_F',
  VAR: 'EXPANDED_VAR'
}
