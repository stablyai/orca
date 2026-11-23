import { ipcMain } from 'electron'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  hermesActiveProfileName,
  hermesProfileNames,
  readServerDirNames
} from '../../hermes/hermes-launch-profile-names'
import { getHermesHome, resolveHermesActiveProfileHome } from '../../hermes/hermes-default-home'
import { hermesProfileRoot } from '../../../shared/agent-launch/startup/hermes-profile'
import type {
  HermesLaunchProfileRequest,
  HermesLaunchProfiles
} from '../../../shared/hermes/hermes-launch-profiles'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { connectionManager } from '../ssh/ssh-ipc-context'
import { browseSshDirectory } from '../../ssh/filesystem/ssh-remote-directory-browse'
import { readSshHomeTextFile } from '../../ssh/filesystem/ssh-remote-home-file-read'
import { parseExecutionHostId } from '../../../shared/execution-host/execution-host'
import { parseWslPath } from '../../wsl/filesystem/unc-path-access'
import { callRuntimeEnvironment } from '../runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/catalog/runtime-environment-registry-root'
import { wslHomeUnlessStopped } from '../../wsl/discovery/wsl-home-unless-stopped'
import {
  wslGatedReaddir,
  wslGatedReadFile
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'

/**
 * The named profiles a `hermes -p <id>` launch can pick, plus the one the current environment
 * would use. A null answer (unknown host, absent store) leaves the pane's row a plain launch.
 */
export async function listHermesLaunchProfiles(
  args: HermesLaunchProfileRequest = {}
): Promise<HermesLaunchProfiles | null> {
  const parsed = parseExecutionHostId(args.executionHostId)
  if (parsed?.kind === 'runtime') {
    return listRuntimeHermesLaunchProfiles(parsed.environmentId)
  }
  if (parsed?.kind === 'ssh') {
    return listSshHermesLaunchProfiles(parsed.targetId)
  }
  const wslDistro = wslDistroForWorktreeId(args.worktreeId)
  if (wslDistro) {
    return listWslHermesLaunchProfiles(wslDistro)
  }
  return listLocalHermesLaunchProfiles()
}

/** The desktop's own install: `%LOCALAPPDATA%\hermes` or `~/.hermes`, plus its sticky choice. */
async function listLocalHermesLaunchProfiles(): Promise<HermesLaunchProfiles> {
  const home = getHermesHome()
  const root = hermesProfileRoot(home)
  const profiles = hermesProfileNames(safeLocalReaddirNames(join(root, 'profiles')))
  const activeHome = await resolveHermesActiveProfileHome(home)
  return {
    profiles,
    active: activeHome === root ? null : basename(activeHome)
  }
}

function safeLocalReaddirNames(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** A WSL workspace runs Hermes inside its distro, whose home differs from the desktop's. */
async function listWslHermesLaunchProfiles(distro: string): Promise<HermesLaunchProfiles | null> {
  const home = await wslHomeUnlessStopped(distro)
  if (!home) {
    return null
  }
  const hermesHome = join(home, '.hermes')
  const entries = await wslGatedReaddir(join(hermesHome, 'profiles'), 'scan').then(
    (listed) => listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    (): string[] => []
  )
  const active = await wslGatedReadFile(join(hermesHome, 'active_profile'), 'utf-8', 'scan').then(
    hermesActiveProfileName,
    () => null
  )
  return { profiles: hermesProfileNames(entries), active }
}

function wslDistroForWorktreeId(worktreeId: string | undefined): string | null {
  const path = worktreeId ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath : undefined
  return path ? (parseWslPath(path)?.distro ?? null) : null
}

/** The host's own install under its `$HOME/.hermes`; hooks already install there. */
async function listSshHermesLaunchProfiles(targetId: string): Promise<HermesLaunchProfiles | null> {
  if (!connectionManager) {
    return null
  }
  const browse = await browseSshDirectory(connectionManager, targetId, '~/.hermes/profiles').catch(
    (error: unknown) => {
      console.warn('[hermes] could not list profiles over SSH', targetId, error)
      return null
    }
  )
  // An absent store or a refused listing leaves the row a plain launch.
  if (!browse) {
    return null
  }
  // The helper resolves null for an absent or unreadable file; it never rejects.
  const active = await readSshHomeTextFile(connectionManager, targetId, '.hermes/active_profile')
  return {
    profiles: hermesProfileNames(
      browse.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
    ),
    active: hermesActiveProfileName(active)
  }
}

/** A host that runs Orca's own server reads its Hermes home through that server, which is where
 *  Hermes and its files live. `active_profile` has no server-file read, so the sticky choice stays
 *  unknown there and the menu marks Default. */
async function listRuntimeHermesLaunchProfiles(
  environmentId: string
): Promise<HermesLaunchProfiles | null> {
  const response = await callRuntimeEnvironment(
    getRuntimeEnvironmentRegistryRoot(),
    environmentId,
    'files.browseServerDir',
    { path: '~/.hermes/profiles' },
    15_000
  ).catch((error: unknown) => {
    console.warn('[hermes] could not list profiles on the runtime host', environmentId, error)
    return null
  })
  if (!response) {
    return null
  }
  if (response.ok !== true) {
    console.warn('[hermes] runtime host refused the profile listing', environmentId, response.error)
    return null
  }
  return { profiles: hermesProfileNames(readServerDirNames(response.result)), active: null }
}

export function registerHermesLaunchProfileHandlers(): void {
  ipcMain.handle('hermes:launchProfiles', (_event, args: HermesLaunchProfileRequest | undefined) =>
    listHermesLaunchProfiles(args ?? {})
  )
}
