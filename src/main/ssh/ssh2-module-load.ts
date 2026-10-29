import type * as Ssh2 from 'ssh2'

/** Load ssh2 on first use; requiring it at startup costs ~55ms before any window (#35731). */
export function loadSsh2(): typeof Ssh2 {
  return require('ssh2')
}
