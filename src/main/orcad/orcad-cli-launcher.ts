import { chmod, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCAD_CLI_ENTRY_FILENAME } from '../../shared/orcad-artifacts'
import { buildUnixCliLauncher } from '../cli/cli-dev-launcher'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveOrcadInstallRoot, resolveUserDataPath } from './orcad-app-paths'

let launcherPath: string | null = null

export function getOrcadCliLauncherPath(): string | null {
  return launcherPath
}

export async function prepareOrcadCliLauncher(): Promise<void> {
  launcherPath = null
  // Windows needs a native argv-preserving launcher; never proxy message bodies through cmd.exe.
  if (process.platform === 'win32') {
    return
  }
  const entry = join(resolveOrcadInstallRoot(), ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
  // Older server slots and source-only runs may not include the CLI yet.
  if (!existsSync(entry)) {
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
