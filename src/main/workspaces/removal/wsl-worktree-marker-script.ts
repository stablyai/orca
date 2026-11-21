import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { RemoveLocalWorktreeMarkerOptions } from './local-worktree-filesystem'

const PARSE_ORCA_GITDIR_LINE = [
  'orca_line=$(LC_ALL=C head -n 1 ./.git)',
  'orca_line="${orca_line%"${orca_line##*[![:space:]]}"}"',
  'case "$orca_line" in [Gg][Ii][Tt][Dd][Ii][Rr]:*) orca_gitdir=${orca_line#*:}; orca_gitdir="${orca_gitdir#"${orca_gitdir%%[![:space:]]*}"}" ;; *) orca_gitdir="" ;; esac'
].join(' && ')

// Pin the sweep to a subshell cwd verified against orca_root_meta; exit the subshell before rmdir so DrvFs holds no cwd handle (#16463).
export function buildWslMarkerLastScript(
  target: string,
  { expectedMarker, forbidAnyMarker = false, expectedRoot }: RemoveLocalWorktreeMarkerOptions
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
    'LC_ALL=C find -P . -mindepth 1 -maxdepth 1 \\( ! -iname .git -o ! -samefile ./.git \\) -exec rm -rf -- {} + &&',
    'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $? &&',
    'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac &&',
    'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi &&',
    "if orca_after=$(LC_ALL=C stat -c '%F#%d:%i' -- ./.git 2>&1); then",
    "case \"$orca_after\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac &&",
    'if [ "${orca_after#*#}" != "$orca_marker_id" ]; then exit 4; fi &&',
    `${PARSE_ORCA_GITDIR_LINE} &&`,
    'if [ "$orca_gitdir" != "$orca_saved_gitdir" ]; then exit 4; fi &&',
    'LC_ALL=C rm -f -- ./.git;',
    "else case \"$orca_after\" in *': No such file or directory'|*': Not a directory') ;; *) printf '%s\\n' \"$orca_after\" >&2; exit 1 ;; esac; fi;",
    'else',
    "if LC_ALL=C stat -c '%F' -- ./.git >/dev/null 2>&1; then exit 4; fi &&",
    'LC_ALL=C find -P . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} + &&',
    'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $? &&',
    'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac &&',
    'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi &&',
    "if orca_after=$(LC_ALL=C stat -c '%F' -- ./.git 2>&1); then exit 4;",
    "else case \"$orca_after\" in *': No such file or directory'|*': Not a directory') ;; *) printf '%s\\n' \"$orca_after\" >&2; exit 1 ;; esac; fi;",
    'fi ) || exit $?;',
    'orca_cur_root=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target") || exit $?;',
    'case "$orca_cur_root" in \'directory#\'*) ;; *) echo "Refusing to delete non-directory worktree path" >&2; exit 3 ;; esac;',
    'if [ "$orca_cur_root" != "$orca_root_meta" ]; then exit 4; fi;',
    'if ! LC_ALL=C rmdir -- "$orca_target"; then',
    'if LC_ALL=C stat -c \'%F\' -- "$orca_target/.git" >/dev/null 2>&1; then exit 4; fi;',
    'if [ -n "$(LC_ALL=C ls -A -- "$orca_target" 2>/dev/null)" ]; then exit 5; fi;',
    'exit 1;',
    'fi'
  ]
    .filter(Boolean)
    .join(' ')
}
