import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  removeManagedCommands,
  wrapPosixHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { COPILOT_EVENTS } from './copilot-managed-hook-definitions'
import { getManagedScript } from './copilot-managed-script'

function getRemoteManagedHookDefinition(command: string): HookDefinition {
  return { type: 'command', bash: command, timeoutSec: 5 }
}

export async function installCopilotHooksRemote(
  sftp: SFTPWrapper,
  remoteHome: string
): Promise<AgentHookInstallStatus> {
  const home = remoteHome.replace(/\/$/, '')
  const remoteConfigPath = `${home}/.copilot/hooks/orca.json`
  const remoteScriptPath = `${home}/.orca/agent-hooks/copilot-hook.sh`

  try {
    const config = await readHooksJsonRemote(sftp, remoteConfigPath)
    if (!config) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: 'Could not parse remote Copilot hooks/orca.json'
      }
    }

    const nextHooks = { ...config.hooks }
    const managedEvents = new Set<string>(COPILOT_EVENTS)
    const isManagedCommand = createManagedCommandMatcher('copilot-hook.sh')

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

    for (const eventName of COPILOT_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      nextHooks[eventName] = [
        ...cleaned,
        getRemoteManagedHookDefinition(
          wrapPosixHookCommand(remoteScriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
        )
      ]
    }

    config.version = 1
    delete config.disableAllHooks
    config.hooks = nextHooks
    // Why: SSH remotes use POSIX scripts regardless of Orca's local OS. Write
    // the script before hooks/orca.json so a partial install cannot point
    // Copilot at a missing managed command.
    await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
    await writeHooksJsonRemote(sftp, remoteConfigPath, config)

    return {
      agent: 'copilot',
      state: 'installed',
      configPath: remoteConfigPath,
      managedHooksPresent: true,
      detail: null
    }
  } catch (err) {
    return {
      agent: 'copilot',
      state: 'error',
      configPath: remoteConfigPath,
      managedHooksPresent: false,
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}
