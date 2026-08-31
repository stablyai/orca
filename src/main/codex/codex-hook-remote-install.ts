import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { upsertHookTrustEntriesInContent, type CodexTrustEntry } from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  wrapReadablePosixHookCommand
} from './codex-hook-definition'
import { getManagedScript } from './codex-hook-script'

export async function installCodexHooksRemote(
  sftp: SFTPWrapper,
  remoteHome: string,
  options?: { codexHomeDir?: string; deferTrustUntilConfigToml?: boolean }
): Promise<AgentHookInstallStatus> {
  const codexHomeBase =
    options?.codexHomeDir?.replace(/\/$/, '') ?? `${remoteHome.replace(/\/$/, '')}/.codex`
  const remoteConfigPath = `${codexHomeBase}/hooks.json`
  const remoteTomlPath = `${codexHomeBase}/config.toml`
  // Redirected WSL homes must use the same script location and command shape
  // as the runtime installer; two representations of one hooks.json race
  // into stale trust keys. Plain SSH keeps its guest-home script contract.
  const redirectedCodexHome = options?.codexHomeDir?.replace(/\/$/, '')
  const remoteScriptPath = redirectedCodexHome
    ? `${redirectedCodexHome}/.orca/agent-hooks/codex-hook.sh`
    : `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/codex-hook.sh`
  try {
    const config = await readHooksJsonRemote(sftp, remoteConfigPath)
    if (!config) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: 'Could not parse remote Codex hooks.json'
      }
    }

    const command = redirectedCodexHome
      ? wrapReadablePosixHookCommand(remoteScriptPath)
      : wrapPosixHookCommand(remoteScriptPath)
    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(CODEX_EVENTS)
    const isManagedCommand = createManagedCommandMatcher('codex-hook.sh')

    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    const trustEntries: CodexTrustEntry[] = []
    for (const eventName of CODEX_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        hooks: [buildManagedCommandHook(command)]
      }
      nextHooks[eventName] = redirectedCodexHome
        ? [definition, ...cleaned]
        : [...cleaned, definition]
      trustEntries.push({
        sourcePath: remoteConfigPath,
        eventLabel: CODEX_EVENT_LABEL[eventName],
        groupIndex: redirectedCodexHome ? 0 : cleaned.length,
        handlerIndex: 0,
        command,
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      })
    }

    config.hooks = nextHooks
    // Why: write script/settings before trust TOML; a partial trust write leaves Codex asking approval instead of running a missing script.
    // Why: SSH remotes use POSIX `.sh` paths even when Orca runs on Windows; never derive remote script syntax from local OS.
    await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
    // Why: SSH edits the user's remote ~/.codex/hooks.json directly, so preserve non-Orca top-level metadata while replacing the hooks tree.
    await writeHooksJsonRemote(sftp, remoteConfigPath, { ...config, hooks: nextHooks })
    try {
      const existingTomlRaw = await readTextFileRemote(sftp, remoteTomlPath)
      if (existingTomlRaw === null && options?.deferTrustUntilConfigToml === true) {
        return {
          agent: 'codex',
          state: 'installed',
          configPath: remoteConfigPath,
          managedHooksPresent: true,
          detail: 'Trust entries deferred until config.toml is seeded by the launch path'
        }
      }
      const existingToml = existingTomlRaw ?? ''
      const updatedToml = upsertHookTrustEntriesInContent(existingToml, trustEntries)
      if (updatedToml !== existingToml) {
        await writeTextFileRemoteAtomic(sftp, remoteTomlPath, updatedToml)
      }
    } catch (error) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: `Hooks installed but trust entries could not be written: ${
          error instanceof Error ? error.message : String(error)
        }. Run /hooks in Codex on the remote host to approve.`
      }
    }

    return {
      agent: 'codex',
      state: 'installed',
      configPath: remoteConfigPath,
      managedHooksPresent: true,
      detail: null
    }
  } catch (err) {
    return {
      agent: 'codex',
      state: 'error',
      configPath: remoteConfigPath,
      managedHooksPresent: false,
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}
