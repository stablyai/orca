// Pane and HOME guards Orca emits, e.g. [ -n "${ORCA_PANE_KEY-}${ORCA_AGENT_PANE-}" ].
const POSIX_ENV_GUARD_CLAUSE = /^\[ -n "(?:\$\{(?:ORCA_PANE_KEY|ORCA_AGENT_PANE|HOME)-\})+" \]$/
const POSIX_SCRIPT_FILE_TEST_PREFIX = /^\[ -[frx] /
// One `[ ... ]` test; quoted operands are whole tokens, so `]` or ` && ` inside a path stays put.
const POSIX_TEST_CLAUSE = /^\[ (?:'[^']*'|"[^"]*"|\\.|[^'"\\\]])* \]/
const POSIX_AND_SEPARATOR = /^[ \t]+&&[ \t]+/

/** Splits `[ a ] && [ b ]` into its test clauses, or null when anything else is present. */
function splitPosixTestConjunction(condition: string): string[] | null {
  const clauses: string[] = []
  let rest = condition.trim()
  for (;;) {
    const clause = rest.match(POSIX_TEST_CLAUSE)
    if (!clause) {
      return null
    }
    clauses.push(clause[0])
    rest = rest.slice(clause[0].length)
    if (!rest) {
      return clauses
    }
    const separator = rest.match(POSIX_AND_SEPARATOR)
    if (!separator) {
      return null
    }
    rest = rest.slice(separator[0].length)
  }
}

/** True when every clause is a guard Orca emits: a pane/HOME check or a test of the managed script. */
export function isOrcaPosixCondition(
  condition: string,
  isManagedScriptPathToken: (token: string) => boolean
): boolean {
  const clauses = splitPosixTestConjunction(condition)
  return (
    clauses !== null &&
    clauses.every(
      (clause) =>
        POSIX_ENV_GUARD_CLAUSE.test(clause) ||
        (POSIX_SCRIPT_FILE_TEST_PREFIX.test(clause) &&
          isManagedScriptPathToken(clause.slice('[ -f '.length, -' ]'.length)))
    )
  )
}
