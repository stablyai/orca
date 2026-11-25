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
/** Each folder's sweep of an earlier run's files, done once per run. */
const swept = new Map<string, Promise<void>>()

async function launchDir(): Promise<string> {
  const dir = join(getAppEnvironment().getPath('userData'), DIR)
  // Made again each time: removing it while Orca runs mustn't stop later launches.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let sweep = swept.get(dir)
  if (!sweep) {
    // An earlier run's files name tokens that died with it; a terminal that survived the restart
    // already read its file at start.
    sweep = readdir(dir).then(async (names) => {
      // Config files only: a Pi extension holds no token, and a Pi that outlived the restart
      // reloads it from here.
      for (const name of names.filter((file) => file.endsWith('.json'))) {
        await rm(join(dir, name), { force: true })
      }
    })
    swept.set(dir, sweep)
  }
  await sweep.catch(() => undefined)
  return dir
}

/** Writes `contents` for `agent`'s launch and answers its path on this host. */
export async function writeTerminalMcpLaunchFile(
  agent: string,
  contents: string,
  extension = 'json'
): Promise<string> {
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 24)
  const path = join(await launchDir(), `${agent}-${digest}.${extension}`)
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
