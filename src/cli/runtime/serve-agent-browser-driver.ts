import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'
import { isProcessAlive } from '../../shared/serve-bundle-coordination'
import { publishClaimedSnapshot, removeUnusedSnapshots } from './claimed-snapshot-store'

/** The installed app's agent-browser driver, for orcad's Chromium provider (#33846). Packaged apps ship it in `resources`; a dev checkout keeps it in node_modules. */
export function findAppAgentBrowserDriver(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  const name = orcadAgentBrowserNativeName(platform, arch)
  return [
    join(dirname(appRoot), name),
    join(appRoot, 'node_modules', 'agent-browser', 'bin', name)
  ].find((path) => existsSync(path))
}

/** Windows locks a running image, so orcad's long-lived daemon runs a profile copy that app updates never replace. */
export async function stageAppAgentBrowserDriver(
  appRoot: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<string | undefined> {
  const driver = findAppAgentBrowserDriver(appRoot, platform, arch)
  if (!driver || platform !== 'win32') {
    return driver
  }
  const root = join(userDataPath, 'orcad-agent-browser')
  try {
    const { size, mtimeMs } = await stat(driver)
    const id = `${size}-${Math.trunc(mtimeMs)}`
    await mkdir(root, { recursive: true })
    const snapshot = await publishClaimedSnapshot(root, id, process.pid, (directory) =>
      copyFile(driver, join(directory, basename(driver)))
    )
    // A copy still running for another serve stays locked and survives until a later pass.
    await removeUnusedSnapshots(root, id, isProcessAlive)
    return join(snapshot, basename(driver))
  } catch {
    // Without a copy, Chromium stays unavailable rather than locking the installed image.
    return undefined
  }
}
