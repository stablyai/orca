import { homedir } from 'node:os'
import { join } from 'node:path'

/** Windows ssh -G leaves this token unexpanded; a literal path would hide system known_hosts, including changed keys. */
const PROGRAMDATA_TOKEN = '__PROGRAMDATA__'

/** Match the whole token or a separator boundary so __PROGRAMDATA__evil is never rewritten. */
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
    // Preserve an unset token rather than invent a path whose absence could hide trusted hosts.
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
