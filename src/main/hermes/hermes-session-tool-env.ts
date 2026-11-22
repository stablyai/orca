// Hermes runs every chat's tools in one gateway per profile. Orca's plugin there hands each tool the
// environment Orca wrote for its session (Hermes' per-session env hook, 0.23.1+), read at each spawn.
import { randomBytes } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PublishSharedToolProcessSessionEnv } from '../runtime/agent-session/environment/shared-tool-process-session-env'
import { resolveHermesActiveProfileHome } from './hermes-default-home'
import {
  HERMES_PLUGIN_NAME,
  HERMES_SESSION_ENV_DIR,
  HERMES_SESSION_ID_PATTERN
} from './hermes-managed-plugin-source'

export const publishHermesSessionToolEnv: PublishSharedToolProcessSessionEnv = async ({
  env,
  providerSessionId,
  values,
  live
}) => {
  if (!new RegExp(`^${HERMES_SESSION_ID_PATTERN}$`).test(providerSessionId)) {
    throw new Error('Hermes named its session with characters Orca does not write to a file name')
  }
  // The launch pins HERMES_HOME; a chat on the root follows its active profile, as Hermes does.
  const pinned = env.HERMES_HOME?.trim()
  if (!pinned) {
    return async () => undefined
  }
  const pluginDir = join(
    await resolveHermesActiveProfileHome(pinned),
    'plugins',
    HERMES_PLUGIN_NAME
  )
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
  const publication = Symbol(providerSessionId)
  await inTurn(file, async () => {
    // A child that exited while this waited must not replace a reopened chat's file.
    if (!live()) {
      return
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Renamed into place so a tool spawned meanwhile never reads half a file.
    const staged = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(staged, JSON.stringify(values), { mode: 0o600 })
    await rename(staged, file)
    owners.set(file, publication)
  })
  return () =>
    inTurn(file, async () => {
      // A later child of the same conversation owns the file now.
      if (owners.get(file) !== publication) {
        return
      }
      owners.delete(file)
      await rm(file, { force: true })
    })
}

/** Each file's latest publication; files are written and removed only in this process. */
const owners = new Map<string, symbol>()
const turns = new Map<string, Promise<void>>()

/** Runs each file's writes and removals in order. */
function inTurn(file: string, run: () => Promise<void>): Promise<void> {
  const next = (turns.get(file) ?? Promise.resolve()).then(run)
  const settled = next.catch(() => undefined)
  turns.set(file, settled)
  void settled.then(() => {
    if (turns.get(file) === settled) {
      turns.delete(file)
    }
  })
  return next
}
