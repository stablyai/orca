import { win32 } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { readRunningWslHomeDirsUnlessStopped } from '../wsl/discovery/wsl-home-unless-stopped'
import {
  wslGatedLstat,
  wslGatedReadFile,
  wslGatedReaddir,
  wslGatedRealpath
} from '../native-chat/wsl-transcript-fs-access'
import { wslRuntimeHomePathsEqual } from '../codex/configuration/homes/managed-wsl-codex-home-registry'
import type { CodexUsageSourceDiscovery } from './codex-usage-sources'

export async function discoverWslCodexUsageSources(
  platform: NodeJS.Platform = process.platform
): Promise<CodexUsageSourceDiscovery> {
  if (platform !== 'win32') {
    return { sources: [], wslHomes: [], complete: true }
  }
  const { homes, confirmed } = await readRunningWslHomeDirsUnlessStopped()
  const result: CodexUsageSourceDiscovery = { sources: [], wslHomes: homes, complete: confirmed }
  for (const home of homes) {
    const distro = parseWslUncPath(home)?.distro
    if (!distro) {
      result.complete = false
      continue
    }
    const dataRoot = win32.join(home, '.local', 'share', 'orca')
    result.sources.push(
      { directory: win32.join(home, '.codex', 'sessions'), distro },
      { directory: win32.join(dataRoot, 'codex-runtime-home', 'home', 'sessions'), distro }
    )
    try {
      result.sources.push(...(await discoverAccountSessions(dataRoot, distro)))
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        result.complete = false
      }
    }
  }
  return result
}

async function discoverAccountSessions(dataRoot: string, distro: string) {
  const accountsRoot = win32.join(dataRoot, 'codex-accounts')
  const canonicalRoot = await wslGatedRealpath(accountsRoot)
  if (!wslRuntimeHomePathsEqual(accountsRoot, canonicalRoot)) {
    throw new Error('Redirected WSL Codex accounts root')
  }
  const sources: CodexUsageSourceDiscovery['sources'] = []
  for (const entry of await wslGatedReaddir(accountsRoot, 'scan')) {
    if (!entry.isDirectory()) {
      continue
    }
    const accountHome = win32.join(accountsRoot, entry.name, 'home')
    try {
      const canonicalHome = await wslGatedRealpath(accountHome)
      const marker = await wslGatedReadFile(
        win32.join(accountHome, '.orca-managed-home'),
        'utf8',
        'scan'
      )
      if (!wslRuntimeHomePathsEqual(accountHome, canonicalHome) || marker.trim() !== entry.name) {
        continue
      }
      const directory = win32.join(accountHome, 'sessions')
      if ((await wslGatedLstat(directory, 'scan')).isDirectory()) {
        sources.push({ directory, distro })
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
  return sources
}
