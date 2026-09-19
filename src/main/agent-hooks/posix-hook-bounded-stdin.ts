import type { PosixHookStdinReader } from './hook-stdin-contract'

export const POSIX_HOOK_EOF_TIMEOUT_SECONDS = 5

// A timed-out EOF reader must fail capture rather than forward a truncated payload.
export const POSIX_HOOK_BOUNDED_STDIN: PosixHookStdinReader = {
  reader: 'orca_read_hook_to_eof',
  prelude: [
    'orca_read_hook_to_eof() (',
    '  exec 3<&0',
    '  if command -p cat </dev/null >/dev/null 2>&1; then',
    '    command -p cat <&3 2>/dev/null &',
    '  else',
    '    command cat <&3 2>/dev/null &',
    '  fi',
    '  orca_reader=$!',
    '  (',
    `    command -p sleep ${POSIX_HOOK_EOF_TIMEOUT_SECONDS} &`,
    '    orca_sleeper=$!',
    '    trap \'kill "$orca_sleeper" 2>/dev/null; wait "$orca_sleeper" 2>/dev/null; exit 0\' TERM',
    '    wait "$orca_sleeper"',
    '    kill "$orca_reader" 2>/dev/null',
    '  ) >/dev/null 2>&1 &',
    '  orca_watchdog=$!',
    '  wait "$orca_reader" 2>/dev/null',
    '  orca_read_status=$?',
    '  kill "$orca_watchdog" 2>/dev/null',
    '  wait "$orca_watchdog" 2>/dev/null',
    '  exit "$orca_read_status"',
    ')'
  ]
}
