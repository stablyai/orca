import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/orcad-artifacts'
import { nodeFileContentsEqual } from '../../shared/node-file-content-equality'
import { buildUnixCliLauncher } from '../cli/cli-dev-launcher'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'

// Read by native/windows-cli-launcher: its presence beside orca.exe selects the server mode.
export const ORCAD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME = 'orca-launcher.cfg'
const RETIRED_LAUNCHER_SUFFIX = '.retired'

let launcherPath: string | null = null

export function getOrcadCliLauncherPath(): string | null {
  return launcherPath
}

export async function prepareOrcadCliLauncher(): Promise<void> {
  launcherPath = null
  const installRoot = resolveOrcadInstallRoot()
  const entry = join(installRoot, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
  // Older server slots and source-only runs may not include the CLI yet.
  if (!existsSync(entry)) {
    return
  }
  const userDataPath = resolveUserDataPath()
  const binDir = join(userDataPath, 'cli', 'bin')
  if (process.platform === 'win32') {
    launcherPath = await prepareWindowsLauncher(installRoot, entry, userDataPath, binDir)
    return
  }
  const path = join(binDir, 'orca')
  const script = buildUnixCliLauncher(process.execPath, entry, userDataPath, 'node')
  await mkdir(binDir, { recursive: true })
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== script) {
    writeFileAtomically(path, script, { mode: 0o700 })
  }
  await chmod(path, 0o700)
  launcherPath = path
}

export function buildWindowsCliLauncherConfig(
  nodePath: string,
  cliEntryPath: string,
  userDataPath: string
): string {
  return `node=${nodePath}\ncli=${cliEntryPath}\nuser-data=${userDataPath}\n`
}

/** A native exe, never a .cmd: cmd.exe reparses `%*` and cannot carry a multi-line body. */
async function prepareWindowsLauncher(
  installRoot: string,
  entry: string,
  userDataPath: string,
  binDir: string
): Promise<string | null> {
  const source = join(installRoot, ...ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
  if (!existsSync(source)) {
    return null
  }
  const path = join(binDir, 'orca.exe')
  await mkdir(binDir, { recursive: true })
  await removeRetiredLaunchers(binDir)
  const binary = await readFile(source)
  if (!(await nodeFileContentsEqual(path, binary).catch(() => false))) {
    try {
      writeFileAtomically(path, binary)
    } catch {
      // A running `orca` keeps its image mapped; Windows still lets it be renamed away.
      await rename(path, `${path}.${randomUUID()}${RETIRED_LAUNCHER_SUFFIX}`)
      writeFileAtomically(path, binary)
    }
  }
  const configPath = join(binDir, ORCAD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME)
  const config = buildWindowsCliLauncherConfig(process.execPath, entry, userDataPath)
  if ((await readFile(configPath, 'utf8').catch(() => null)) !== config) {
    writeFileAtomically(configPath, config)
  }
  return path
}

async function removeRetiredLaunchers(binDir: string): Promise<void> {
  const names = await readdir(binDir).catch(() => [])
  await Promise.all(
    names
      .filter((name) => name.startsWith('orca.exe.') && name.endsWith(RETIRED_LAUNCHER_SUFFIX))
      // One still running stays until a later start.
      .map((name) => rm(join(binDir, name), { force: true }).catch(() => {}))
  )
}
