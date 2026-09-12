/**
 * The shell half of the ownership tri-state.
 *
 * Every WSL ownership defect in STA-5616 has been the same mistake in a new
 * place: a shell construct where "I could not look" and "the answer is no" share
 * one representation. `test -e` returns 1 for absent AND for EACCES on a parent.
 * `cmd | grep -q` returns non-zero when grep found nothing AND when the producer
 * died mid-pipe. `$(cat f)` yields an empty string when the file is empty AND
 * when the read failed. Each was patched individually and the class came back.
 *
 * So the guest observes through exactly one primitive, `kind_of`, under one
 * invariant:
 *
 *   A dispositive answer may only be derived from a command that SUCCEEDED.
 *   A filesystem `test` may be trusted when it says yes, never when it says no.
 *   No decision is ever read from a pipeline's exit status.
 *
 * `kind_of` reports the type of one path, or exits with the caller's
 * "unknown" status. It never reports absence without a complete, successful
 * directory listing to back it — and that listing's status is checked
 * separately from whether the name appears in it, because those are different
 * questions and conflating them is exactly the bug.
 */

/** Exit status meaning "the guest could not determine this"; never a verdict. */
export type GuestUnknownExit = number

/**
 * Emits the shared prelude. `KIND` is set to one of `absent`, `regular`,
 * `symlink`, `dir`, `other`; callers branch on it with `case`, which operates on
 * a shell variable and therefore cannot fail for I/O reasons.
 */
export function buildWslGuestObservationPrelude(unknownExit: GuestUnknownExit): string[] {
  return [
    // A literal newline, so a listing can be searched with `case` instead of a
    // pipeline whose exit status conflates "no match" with "producer died".
    "NL='",
    "'",
    `unknown() { exit ${unknownExit}; }`,
    // $1 path, $2 its parent, $3 its basename.
    'kind_of() {',
    '  _meta=$(ls -ldn -- "$1" 2>/dev/null) || _meta=',
    '  if [ -n "$_meta" ]; then',
    '    case "$_meta" in',
    '      -*) KIND=regular ;;',
    '      l*) KIND=symlink ;;',
    '      d*) KIND=dir ;;',
    '      *) KIND=other ;;',
    '    esac',
    '    return 0',
    '  fi',
    // `ls -ld` failing means absent OR unreadable, which are different answers.
    // Only a listing of the parent separates them, and only if it succeeds.
    '  _listing=$(ls -A -- "$2" 2>/dev/null) || unknown',
    '  case "$NL$_listing$NL" in',
    '    *"$NL$3$NL"*) unknown ;;',
    '    *) KIND=absent ;;',
    '  esac',
    '  return 0',
    '}'
  ]
}
