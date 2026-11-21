import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { RemoveLocalWorktreeMarkerOptions } from './local-worktree-filesystem'

const PARSE_ORCA_GITDIR_LINE = [
  'orca_line=$(LC_ALL=C head -n 1 ./.git)',
  'orca_line="${orca_line%"${orca_line##*[![:space:]]}"}"',
  'case "$orca_line" in [Gg][Ii][Tt][Dd][Ii][Rr]:*) orca_gitdir=${orca_line#*:}; orca_gitdir="${orca_gitdir#"${orca_gitdir%%[![:space:]]*}"}" ;; *) orca_gitdir="" ;; esac'
].join(' && ')

const VERIFY_MARKER_BATCH_AND_RM = quotePosixShell(
  [
    'orca_t=$1; orca_rm=$2; orca_mid=$3; orca_sgd=$4; shift 4;',
    '[ "$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_t" 2>/dev/null)" = "$orca_rm" ] || exit 4;',
    '[ "$(LC_ALL=C stat -c \'%F#%d:%i\' -- . 2>/dev/null)" = "$orca_rm" ] || exit 4;',
    "if orca_m=$(LC_ALL=C stat -c '%F#%d:%i' -- ./.git 2>&1); then",
    "case \"$orca_m\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac;",
    '[ "${orca_m#*#}" = "$orca_mid" ] || exit 4;',
    'orca_line=$(LC_ALL=C head -n 1 ./.git) || exit 4;',
    'orca_line="${orca_line%"${orca_line##*[![:space:]]}"}";',
    'case "$orca_line" in [Gg][Ii][Tt][Dd][Ii][Rr]:*) orca_gd=${orca_line#*:}; orca_gd="${orca_gd#"${orca_gd%%[![:space:]]*}"}" ;; *) orca_gd="" ;; esac;',
    '[ "$orca_gd" = "$orca_sgd" ] || exit 4;',
    'LC_ALL=C exec rm -rf -- "$@";',
    "else case \"$orca_m\" in *': No such file or directory'|*': Not a directory') exit 0 ;; *) printf '%s\\n' \"$orca_m\" >&2; exit 1 ;; esac; fi"
  ].join(' ')
)

const VERIFY_MARKERLESS_BATCH_AND_RM = quotePosixShell(
  [
    'orca_t=$1; orca_rm=$2; shift 2;',
    '[ "$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_t" 2>/dev/null)" = "$orca_rm" ] || exit 4;',
    '[ "$(LC_ALL=C stat -c \'%F#%d:%i\' -- . 2>/dev/null)" = "$orca_rm" ] || exit 4;',
    "if LC_ALL=C stat -c '%F' -- ./.git >/dev/null 2>&1; then exit 4; fi;",
    'LC_ALL=C exec rm -rf -- "$@"'
  ].join(' ')
)

// Pin the sweep to a subshell cwd verified against orca_root_meta, re-verify before each rm batch, and exit the subshell before rmdir (#16463).
export function buildWslMarkerLastScript(
  target: string,
  {
    expectedMarker,
    forbidAnyMarker = false,
    expectedRoot,
    requireMarker = false
  }: RemoveLocalWorktreeMarkerOptions
): string {
  const expectedClause = forbidAnyMarker
    ? ' || true'
    : expectedMarker !== undefined
      ? ` || [ "$orca_gitdir#$orca_marker_ino" != ${quotePosixShell(expectedMarker)} ]`
      : ''
  const expectedRootClause =
    expectedRoot !== undefined
      ? `if [ "\${orca_root_meta#*#}" != ${quotePosixShell(expectedRoot)} ]; then exit 4; fi;`
      : ''
  const markerlessBranch = requireMarker
    ? "if LC_ALL=C stat -c '%F' -- ./.git >/dev/null 2>&1; then exit 4; fi;"
    : [
        "if LC_ALL=C stat -c '%F' -- ./.git >/dev/null 2>&1; then exit 4; fi &&",
        `orca_find_status=0; LC_ALL=C find -P . -mindepth 1 -maxdepth 1 ! -name .git -exec sh -c ${VERIFY_MARKERLESS_BATCH_AND_RM} sh "$orca_target" "$orca_root_meta" {} + || orca_find_status=$?;`,
        'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $? &&',
        'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac &&',
        'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi &&',
        "if orca_after=$(LC_ALL=C stat -c '%F' -- ./.git 2>&1); then exit 4;",
        'else case "$orca_after" in *\': No such file or directory\'|*\': Not a directory\') if [ "$orca_find_status" -ne 0 ]; then exit "$orca_find_status"; fi ;; *) printf \'%s\\n\' "$orca_after" >&2; exit 1 ;; esac; fi;'
      ].join(' ')
  return [
    `orca_target=${target};`,
    'orca_root_meta=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $?;',
    'case "$orca_root_meta" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac;',
    expectedRootClause,
    '( cd -P -- "$orca_target" || exit $?;',
    "orca_pwd_meta=$(LC_ALL=C stat -c '%F#%d:%i' -- .) || exit $?;",
    'if [ "$orca_pwd_meta" != "$orca_root_meta" ]; then exit 4; fi;',
    "if orca_meta=$(LC_ALL=C stat -c '%F#%d:%i#%i' -- ./.git 2>&1); then orca_has_git=1;",
    "else case \"$orca_meta\" in *': No such file or directory'|*': Not a directory') orca_has_git=0 ;; *) printf '%s\\n' \"$orca_meta\" >&2; exit 1 ;; esac; fi;",
    'if [ "$orca_has_git" = 1 ]; then',
    "case \"$orca_meta\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac &&",
    'orca_rest=${orca_meta#*#} && orca_marker_id=${orca_rest%#*} && orca_marker_ino=${orca_rest#*#} &&',
    `${PARSE_ORCA_GITDIR_LINE} &&`,
    `if [ -z "$orca_gitdir" ]${expectedClause}; then exit 4; fi &&`,
    'orca_saved_gitdir=$orca_gitdir &&',
    `orca_find_status=0; if [ -n "$(LC_ALL=C find -P . -mindepth 1 -maxdepth 1 -name .git -print)" ]; then LC_ALL=C find -P . -mindepth 1 -maxdepth 1 ! -name .git -exec sh -c ${VERIFY_MARKER_BATCH_AND_RM} sh "$orca_target" "$orca_root_meta" "$orca_marker_id" "$orca_saved_gitdir" {} + || orca_find_status=$?; else LC_ALL=C find -P . -mindepth 1 -maxdepth 1 \\( ! -iname .git -o ! -samefile ./.git \\) -exec sh -c ${VERIFY_MARKER_BATCH_AND_RM} sh "$orca_target" "$orca_root_meta" "$orca_marker_id" "$orca_saved_gitdir" {} + || orca_find_status=$?; fi;`,
    'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $? &&',
    'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac &&',
    'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi &&',
    "if orca_after=$(LC_ALL=C stat -c '%F#%d:%i' -- ./.git 2>&1); then",
    "case \"$orca_after\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac &&",
    'if [ "${orca_after#*#}" != "$orca_marker_id" ]; then exit 4; fi &&',
    `${PARSE_ORCA_GITDIR_LINE} &&`,
    'if [ "$orca_gitdir" != "$orca_saved_gitdir" ]; then exit 4; fi &&',
    'if [ "$orca_find_status" -ne 0 ]; then exit "$orca_find_status"; fi &&',
    'LC_ALL=C rm -f -- ./.git;',
    'else case "$orca_after" in *\': No such file or directory\'|*\': Not a directory\') if [ "$orca_find_status" -ne 0 ]; then exit "$orca_find_status"; fi ;; *) printf \'%s\\n\' "$orca_after" >&2; exit 1 ;; esac; fi;',
    'else',
    markerlessBranch,
    'fi ) || exit $?;',
    'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $?;',
    'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac;',
    'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi;',
    'if ! LC_ALL=C rmdir -- "$orca_target"; then',
    'if LC_ALL=C stat -c \'%F\' -- "$orca_target/.git" >/dev/null 2>&1; then exit 4; fi;',
    `if [ -n "$(LC_ALL=C ls -A -- "$orca_target" 2>/dev/null)" ]; then exit ${requireMarker ? '4' : '5'}; fi;`,
    'exit 1;',
    'fi'
  ]
    .filter(Boolean)
    .join(' ')
}
