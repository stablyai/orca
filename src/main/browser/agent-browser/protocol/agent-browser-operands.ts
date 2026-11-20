import { BrowserError } from '../../browser-error'

// agent-browser has no "--" separator, so an operand starting with "--" is parsed as an option
// (`cookies set --curl <file>` reads a file, `wait --download <path>` writes one). Callers String() them.
export function assertAgentBrowserOperands(what: string, operands: readonly unknown[]): void {
  if (operands.some((operand) => operand != null && String(operand).startsWith('--'))) {
    throw new BrowserError(
      'invalid_argument',
      `${what} cannot start with "--": agent-browser would read it as an option.`
    )
  }
}
