// Hermes runs every chat's tools in one gateway per profile. Orca's plugin there hands each tool the
// environment Orca wrote for its session (Hermes' per-session env hook, 0.23.1+), read at each spawn.
import { randomBytes } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PublishSharedToolProcessSessionEnv } from '../runtime/agent-session/environment/shared-tool-process-session-env'
import {
  HERMES_PLUGIN_NAME,
  HERMES_SESSION_ENV_DIR,
  HERMES_SESSION_ID_PATTERN
} from './hermes-managed-plugin-source'

export const publishHermesSessionToolEnv: PublishSharedToolProcessSessionEnv = async ({
  env,
  providerSessionId,
  values
}) => {
  if (!new RegExp(`^${HERMES_SESSION_ID_PATTERN}$`).test(providerSessionId)) {
    throw new Error('Hermes named its session with characters Orca does not write to a file name')
  }
  // The chat's account binding pins the profile's home in its launch environment.
  const home = env.HERMES_HOME?.trim()
  if (!home) {
    return async () => undefined
  }
  const pluginDir = join(home, 'plugins', HERMES_PLUGIN_NAME)
  // Without Orca's plugin in this profile nothing reads the file; its tools keep no identity.
  const installed = await access(join(pluginDir, '__init__.py')).then(
    () => true,
    () => false
  )
  if (!installed) {
    return async () => undefined
  }
  const dir = join(pluginDir, HERMES_SESSION_ENV_DIR)
  const file = join(dir, `${providerSessionId}.json`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Renamed into place so a tool spawned meanwhile never reads half a file.
  const staged = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(staged, JSON.stringify(values), { mode: 0o600 })
  await rename(staged, file)
  return () => rm(file, { force: true })
}
