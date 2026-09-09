import { existsSync, readFileSync } from 'node:fs'
import { posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  resolvePolytokenHooksJsonPath,
  resolveRemotePolytokenHooksJsonPath
} from './polytoken-config-paths'
import {
  applyManagedPolytokenHooks,
  parsePolytokenHooksJson,
  POLYTOKEN_HOOK_EVENTS,
  readManagedPolytokenHookEvents,
  removeManagedPolytokenHooks,
  serializePolytokenHooksJson,
  type PolytokenHookEntry
} from './polytoken-hooks-json'
import {
  getPolytokenManagedCommand,
  getPolytokenManagedScript,
  getPolytokenManagedScriptPath,
  POLYTOKEN_MANAGED_SCRIPT_FILE_NAME
} from './polytoken-hook-script'

type LoadedHooksJson = { ok: true; entries: PolytokenHookEntry[] } | { ok: false; error: string }

// '' when the file does not exist yet (Polytoken creates it lazily).
function loadHooksJson(configPath: string): LoadedHooksJson {
  if (!existsSync(configPath)) {
    return { ok: true, entries: [] }
  }
  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch {
    return { ok: false, error: 'Could not read Polytoken hooks.json' }
  }
  return parsePolytokenHooksJson(text)
}

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'polytoken', state: 'error', configPath, managedHooksPresent: false, detail }
}

function buildStatus(present: Set<string>, configPath: string): AgentHookInstallStatus {
  const missing = POLYTOKEN_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  return { agent: 'polytoken', state, configPath, managedHooksPresent: present.size > 0, detail }
}

function writeHooksJsonEntries(configPath: string, entries: readonly PolytokenHookEntry[]): void {
  // Why: reuse the shared atomic write + rolling backup; `serialized` carries the array
  // because the shared helper's object shape is Claude's, not Polytoken's.
  writeHooksJson(configPath, {}, { serialized: serializePolytokenHooksJson(entries) })
}

export class PolytokenHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(
      getPolytokenManagedScriptPath(),
      getPolytokenManagedScript()
    )
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = resolvePolytokenHooksJsonPath()
    const loaded = loadHooksJson(configPath)
    if (!loaded.ok) {
      return errorStatus(configPath, loaded.error)
    }
    const isManagedCommand = createManagedCommandMatcher(POLYTOKEN_MANAGED_SCRIPT_FILE_NAME)
    return buildStatus(readManagedPolytokenHookEvents(loaded.entries, isManagedCommand), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = resolvePolytokenHooksJsonPath()
    const loaded = loadHooksJson(configPath)
    if (!loaded.ok) {
      return errorStatus(configPath, loaded.error)
    }
    const scriptPath = getPolytokenManagedScriptPath()
    // Write the script first so hooks.json never points at a missing script.
    writeManagedScript(scriptPath, getPolytokenManagedScript())
    writeHooksJsonEntries(
      configPath,
      applyManagedPolytokenHooks(loaded.entries, getPolytokenManagedCommand(scriptPath))
    )
    return this.getStatus()
  }

  // Why: SSH and WSL hosts get the same POSIX script; Polytoken has no native Windows build.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = resolveRemotePolytokenHooksJsonPath(remoteHome)
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      POLYTOKEN_MANAGED_SCRIPT_FILE_NAME
    )
    try {
      const parsed = parsePolytokenHooksJson(
        (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      )
      if (!parsed.ok) {
        return errorStatus(remoteConfigPath, parsed.error)
      }
      const command = wrapPosixHookCommand(
        remoteScriptPath,
        {},
        { requiredEnvVar: 'ORCA_PANE_KEY' }
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getPolytokenManagedScript())
      await writeTextFileRemoteAtomic(
        sftp,
        remoteConfigPath,
        serializePolytokenHooksJson(applyManagedPolytokenHooks(parsed.entries, command))
      )
      return {
        agent: 'polytoken',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return errorStatus(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = resolvePolytokenHooksJsonPath()
    const loaded = loadHooksJson(configPath)
    if (!loaded.ok) {
      return errorStatus(configPath, loaded.error)
    }
    const { entries, changed } = removeManagedPolytokenHooks(loaded.entries)
    if (changed) {
      writeHooksJsonEntries(configPath, entries)
    }
    return this.getStatus()
  }
}

export const polytokenHookService = new PolytokenHookService()
