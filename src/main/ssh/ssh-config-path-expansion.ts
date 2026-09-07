import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows OpenSSH's own placeholder for the system config directory's parent.
 *
 * It prints this token UNEXPANDED from `ssh -G` — captured from a real Windows host:
 * `globalknownhostsfile __PROGRAMDATA__\ssh/ssh_known_hosts __PROGRAMDATA__\ssh/ssh_known_hosts2`.
 * Passed through as a literal it misses with ENOENT, and an absent file is indistinguishable from
 * "no host is known there", so a site-managed `known_hosts` would be silently invisible — including
 * one holding a rotated key that should have produced a mismatch.
 */
const PROGRAMDATA_TOKEN = '__PROGRAMDATA__'

/**
 * What follows the token when this path really starts with it, or null when it does not.
 *
 * A bare `startsWith` also matches a path that merely BEGINS with those characters, so a file named
 * `__PROGRAMDATA__evil/x` would be rewritten to a directory the user never named. It has to be the
 * whole path or be followed by a separator.
 */
function programDataTokenRemainder(filepath: string): string | null {
  if (!filepath.startsWith(PROGRAMDATA_TOKEN)) {
    return null
  }
  const rest = filepath.slice(PROGRAMDATA_TOKEN.length)
  if (rest === '') {
    return rest
  }
  // Both separators, because this path is Windows-shaped but may be parsed anywhere.
  return rest.startsWith('\\') || rest.startsWith('/') ? rest : null
}

export function resolveSshConfigHomePath(filepath: string): string {
  const programDataRest = programDataTokenRemainder(filepath)
  if (programDataRest !== null) {
    // Left alone when the variable is unset rather than guessed: a wrong path reads as "absent",
    // which is the failure this expansion exists to prevent, so it must not be invented.
    const programData = process.env.ProgramData
    return programData ? join(programData, programDataRest) : filepath
  }
  if (filepath === '~') {
    return homedir()
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return join(
      homedir(),
      ...filepath
        .slice(2)
        .split(/[\\/]+/)
        .filter(Boolean)
    )
  }
  return filepath
}
