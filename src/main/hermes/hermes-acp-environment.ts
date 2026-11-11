// Credentials belong in the Hermes home's own .env, so nothing here carries a secret by default.
const FORWARDED_VARIABLES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'HERMES_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  // Windows cannot start Python or resolve its profile folders without these.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
])

/**
 * Forwards only the fixed list and the variables set for Hermes in Orca's agent settings.
 * `hermes acp` is a client of the profile's gateway, and Hermes tools run in that gateway, so this
 * environment reaches tools only when the client itself starts the gateway. A gateway already
 * running, or started as a service, keeps its own environment.
 */
export function scrubHermesAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv,
  chosen: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const spell = (key: string): string => (platform === 'win32' ? key.toUpperCase() : key)
  const kept = new Set(chosen.map(spell))
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const name = spell(key)
    return !FORWARDED_VARIABLES.has(name) && !name.startsWith('LC_') && !kept.has(name)
  })
  for (const key of removed) {
    delete env[key]
  }
  return removed
}
