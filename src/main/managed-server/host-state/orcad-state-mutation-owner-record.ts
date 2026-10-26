/** Prefer /proc over BusyBox ps without -p; parse after the final ) because process names can contain spaces/parens. */
export function posixProcessGroupCommand(pid: string, procRoot = '/proc'): string {
  const stat = `${procRoot}/${pid}/stat`
  return [
    `if [ -r ${stat} ]; then stat=$(cat ${stat} 2>/dev/null); set -- \${stat##*")"}; echo "$3";`,
    `else ps -o pgid= -p ${pid} 2>/dev/null | tr -d " "; fi`
  ].join(' ')
}

/** Publish PID with noclobber so a resumed former holder cannot overwrite a takeover; lock must be shell-quoted. */
export function posixStateMutationPidRecord(lock: string, onTaken: string): string {
  return `set -C; { echo $$ > ${lock}/pid; } 2>/dev/null || { ${onTaken} }; set +C;`
}

/** Record only groups this workload created, avoiding accidental signaling of the surrounding SSH group. */
export function posixStateMutationGroupRecord(lock: string): string {
  return [
    'if [ "${ORCA_STATE_MUTATION_GROUP:-}" = 1 ]; then',
    `group=$(${posixProcessGroupCommand('$$')});`,
    `case "$group" in ""|*[!0-9]*) ;; *) echo "$group" > ${lock}/pgid;; esac; fi;`
  ].join(' ')
}
