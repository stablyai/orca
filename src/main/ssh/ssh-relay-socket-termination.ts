/**
 * Kill whatever process still holds a relay socket, then unlink the socket.
 *
 * Why kill before unlink: the socket file is the only handle anything keeps on a
 * detached relay — GC probes for `relay-*.sock` and reset globs the same name.
 * Unlinking first strands the daemon (and every PTY/agent it owns) with nothing
 * left that can reach or reap it (#8585).
 *
 * `sockExpr` and `pgrepPatternExpr` are shell expressions the caller has already
 * quoted, so this works for both a loop variable and a literal path. Keep the
 * pgrep pattern to the socket basename: `pgrep -f` takes an ERE, and a full
 * versioned path (`relay-0.1.0+<hash>`) would have its `+` read as a quantifier.
 */
export function terminateRelaySocketHolderScript(
  sockExpr: string,
  pgrepPatternExpr: string
): string[] {
  return [
    `if [ -S ${sockExpr} ]; then`,
    '  pid=""',
    // Why: lsof ORs selectors by default; -a keeps this to the one relay socket
    // instead of every Unix-socket holder on the host (#8762).
    '  if command -v lsof >/dev/null 2>&1; then',
    `    pid=$(lsof -t -a -U ${sockExpr} 2>/dev/null | tr "\\n" " ")`,
    '  fi',
    '  if [ -z "$pid" ] && command -v pgrep >/dev/null 2>&1; then',
    `    pid=$(pgrep -f ${pgrepPatternExpr} 2>/dev/null | ` +
      'awk -v self="$$" -v parent="$PPID" \'$1 != self && $1 != parent\' | tr "\\n" " ")',
    '  fi',
    '  if [ -n "$pid" ]; then',
    '    kill -TERM $pid 2>/dev/null || true',
    '    sleep 0.2',
    '    kill -KILL $pid 2>/dev/null || true',
    '  fi',
    `  rm -f ${sockExpr}`,
    'fi'
  ]
}
