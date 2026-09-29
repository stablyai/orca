import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { verifyConptyDirectory } from './build-windows-conpty.mjs'

/** Supply the native selector before Bun starts, replacing inherited foreign providers. */
export function relayDaemonLaunchEnvironment(relayEntry, options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = { ...(options.env ?? process.env) }
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) {
      delete env[key]
    }
  }
  if (platform === 'win32') {
    const directory = dirname(realpathSync(relayEntry))
    verifyConptyDirectory(directory, arch)
    env.BUN_CONPTY_LIBRARY = join(directory, 'conpty.dll')
  }
  return env
}
