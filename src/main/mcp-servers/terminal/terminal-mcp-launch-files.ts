// The per-launch MCP config files a terminal agent reads by path (`--mcp-config <file>`): owner-only
// (0600), named by their content, and kept for this run of Orca only, since any relay token in one
// ends with the run.
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import { wslAutomountRootFor } from '../../wsl/filesystem/wsl-automount-root'

const DIR = 'mcp-terminal-launch'
let ready: Promise<string> | null = null

function launchDir(): Promise<string> {
  ready ??= (async () => {
    const dir = join(getAppEnvironment().getPath('userData'), DIR)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // An earlier run's files name tokens that died with it; a terminal that survived the restart
    // already read its file at start.
    for (const name of await readdir(dir)) {
      await rm(join(dir, name), { force: true })
    }
    return dir
  })().catch((error: unknown) => {
    ready = null
    throw error
  })
  return ready
}

/** Writes `config` as JSON for `agent`'s launch and answers its path on this host. */
export async function writeTerminalMcpLaunchFile(agent: string, config: unknown): Promise<string> {
  const contents = `${JSON.stringify(config, null, 2)}\n`
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 24)
  const path = join(await launchDir(), `${agent}-${digest}.json`)
  await writePluginFileAtomically(path, contents, { mode: 0o600 })
  return path
}

const DRIVE_PATH = /^([A-Za-z]):[/\\](.*)$/

/** A host path as `distro` reads it through its drive mount; null when it isn't on a drive. */
export function wslGuestDrivePath(distro: string | null, path: string): string | null {
  const match = DRIVE_PATH.exec(path)
  if (!match) {
    return null
  }
  const root = wslAutomountRootFor(distro ?? '')
  const base = root.endsWith('/') ? root : `${root}/`
  return `${base}${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}
