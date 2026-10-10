import { chmod, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/orcad-artifacts'
import { buildUnixCliLauncher } from '../cli/cli-dev-launcher'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'

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
  if (process.platform === 'win32') {
    // The slot's native launcher keeps argv intact; never proxy message bodies through cmd.exe.
    // Temporary: per-slot, so a terminal open across two updates loses `orca` once GC drops it.
    const native = join(installRoot, ...ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
    launcherPath = existsSync(native) ? native : null
    return
  }
  const userDataPath = resolveUserDataPath()
  const path = join(userDataPath, 'cli', 'bin', 'orca')
  const script = buildUnixCliLauncher(process.execPath, entry, userDataPath, 'node')
  await mkdir(dirname(path), { recursive: true })
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== script) {
    writeFileAtomically(path, script, { mode: 0o700 })
  }
  await chmod(path, 0o700)
  launcherPath = path
}
