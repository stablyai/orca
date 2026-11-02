/**
 * How a holder records itself in the POSIX state-mutation lock: a mutation, or the exited-owner
 * fence steal that holds the lock across a takeover. A leaf, so the relay's lock commands can use it.
 */

/**
 * Prints `pid`'s process group. Why /proc first: BusyBox `ps` has no `-p`. The comm field
 * may hold spaces and parens, so the fields are read after its last `)`.
 */
export function posixProcessGroupCommand(pid: string, procRoot = '/proc'): string {
  const stat = `${procRoot}/${pid}/stat`
  return [
    `if [ -r ${stat} ]; then stat=$(cat ${stat} 2>/dev/null); set -- \${stat##*")"}; echo "$3";`,
    `else ps -o pgid= -p ${pid} 2>/dev/null | tr -d " "; fi`
  ].join(' ')
}

/**
 * The holder's pid in the mutation lock `lock` (a quoted shell word); `onTaken` runs when another
 * holder's is already there. Noclobber: a run that resumes after a takeover backs off.
 */
export function posixStateMutationPidRecord(lock: string, onTaken: string): string {
  return `set -C; { echo $$ > ${lock}/pid; } 2>/dev/null || { ${onTaken} }; set +C;`
}

/** The holder's own process group, recorded only when it was started as one. */
export function posixStateMutationGroupRecord(lock: string): string {
  return [
    'if [ "${ORCA_STATE_MUTATION_GROUP:-}" = 1 ]; then',
    `group=$(${posixProcessGroupCommand('$$')});`,
    `case "$group" in ""|*[!0-9]*) ;; *) echo "$group" > ${lock}/pgid;; esac; fi;`
  ].join(' ')
}
