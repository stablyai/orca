const PASSTHROUGH_ENV_KEYS = [
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'LOCALAPPDATA',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ'
] as const

export function buildFilesystemHostEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}
