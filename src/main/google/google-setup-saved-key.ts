// Import file for an agent on another host: the key its Orca browser saved in the agent's home that
// no claim took (another tab, or an older host), imported here and removed so the agent never reads it.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { googleSetupAwaitsKey } from '../../shared/google/google-setup-run'
import { botHomeFolder } from '../bots/bot-home'
import { BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY } from '../runtime/browser/downloads/browser-client-download-transfers'
import { getGoogleConnect } from './google-connect'
import { findGoogleKeyInFolder } from './google-key-download-watch'
import { googleSetupRuns } from './google-setup-runs'

/** False when the bot's run waits for no key, or its home holds none for the run's project. */
export async function importGoogleSetupKeySavedHere(
  bot: Pick<Bot, 'id' | 'folder'>,
  keyArrived: () => Promise<unknown>
): Promise<boolean> {
  const run = googleSetupRuns().get(bot.id)
  const connect = getGoogleConnect()
  if (!run || !googleSetupAwaitsKey(run) || !connect) {
    return false
  }
  const folder = join(botHomeFolder(bot), BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY)
  const key = await findGoogleKeyInFolder(folder, {
    since: run.startedAt,
    ...(run.projectId ? { projectId: run.projectId } : {})
  })
  if (!key) {
    return false
  }
  try {
    await connect.importClient(key.text)
  } finally {
    await rm(join(folder, key.name), { force: true }).catch(() => {})
  }
  await keyArrived()
  return true
}
