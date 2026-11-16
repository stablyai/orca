import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { readHooksJson } from '../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import { writeManagedScript } from '../agent-hooks/installation/scripts/managed-hook-script-write'
import { refreshManagedScriptIfPresent } from '../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { readHooksJsonRemote } from '../agent-hooks/installation/configuration/hooks-json-remote'
import { writeDroidHookFileRemote } from './droid-hook-file-remote'
import { writeManagedScriptRemote } from '../agent-hooks/installation/scripts/managed-script-write-remote'
import { applyDroidInstall, applyDroidRemove, type DroidHookFiles } from './droid-hook-config'
import { resolveDroidHookCoverage } from './droid-hook-status'
import {
  getDroidOrgSettingsPath,
  orgAllowsManagedHooksOnly,
  orgAllowsManagedHooksOnlyRemote
} from './droid-org-policy'
import {
  getDroidManagedCommand,
  getDroidManagedScript,
  getDroidManagedScriptFileName,
  getDroidManagedScriptPath
} from './droid-hook-script'

function getHooksJsonPath(): string {
  return join(homedir(), '.factory', 'hooks.json')
}

function getSettingsJsonPath(): string {
  return join(homedir(), '.factory', 'settings.json')
}

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'droid', state: 'error', configPath, managedHooksPresent: false, detail }
}

function readDroidHookFiles(): DroidHookFiles | { error: AgentHookInstallStatus } {
  const configPath = getHooksJsonPath()
  const hooksFile = readHooksJson(configPath)
  if (!hooksFile) {
    return { error: errorStatus(configPath, 'Could not parse Factory hooks.json') }
  }
  const settings = readHooksJson(getSettingsJsonPath())
  if (!settings) {
    return { error: errorStatus(configPath, 'Could not parse Factory settings.json') }
  }
  return { hooksFile, settings }
}

async function readRemoteDroidHookFiles(
  sftp: SFTPWrapper,
  hooksPath: string,
  settingsPath: string
): Promise<DroidHookFiles | { error: AgentHookInstallStatus }> {
  const hooksFile = await readHooksJsonRemote(sftp, hooksPath)
  if (!hooksFile) {
    return { error: errorStatus(hooksPath, 'Could not parse remote Factory hooks.json') }
  }
  const settings = await readHooksJsonRemote(sftp, settingsPath)
  if (!settings) {
    return { error: errorStatus(hooksPath, 'Could not parse remote Factory settings.json') }
  }
  return { hooksFile, settings }
}

export class DroidHookService {
  private readonly orgSettingsPath: string

  constructor(options: { orgSettingsPath?: string } = {}) {
    this.orgSettingsPath = options.orgSettingsPath ?? getDroidOrgSettingsPath()
  }

  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getDroidManagedScriptPath(), getDroidManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const files = readDroidHookFiles()
    if ('error' in files) {
      return files.error
    }
    const command = getDroidManagedCommand(getDroidManagedScriptPath())
    return {
      agent: 'droid',
      configPath: getHooksJsonPath(),
      ...resolveDroidHookCoverage(files, command, orgAllowsManagedHooksOnly(this.orgSettingsPath))
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getHooksJsonPath()
    const scriptPath = getDroidManagedScriptPath()
    // Malformed files must fail before publishing the script.
    const preflight = readDroidHookFiles()
    if ('error' in preflight) {
      return preflight.error
    }
    writeManagedScript(scriptPath, getDroidManagedScript())

    // Merge a /hooks save that landed while the script was published.
    const files = readDroidHookFiles()
    if ('error' in files) {
      return files.error
    }
    const { settingsChanged } = applyDroidInstall(
      files,
      getDroidManagedCommand(scriptPath),
      getDroidManagedScriptFileName()
    )
    // hooks.json shadows the legacy entry before we remove it, avoiding double registration.
    writeHooksJson(configPath, files.hooksFile, { preserveMode: true })
    if (settingsChanged) {
      writeHooksJson(getSettingsJsonPath(), files.settings, { preserveMode: true })
    }
    return this.getStatus()
  }

  // Remote hooks run on the POSIX execution host, even from Windows clients.
  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    platform: 'linux' | 'darwin' = 'linux'
  ): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const hooksPath = `${home}/.factory/hooks.json`
    const settingsPath = `${home}/.factory/settings.json`
    const scriptPath = `${home}/.orca/agent-hooks/droid-hook.sh`
    try {
      const preflight = await readRemoteDroidHookFiles(sftp, hooksPath, settingsPath)
      if ('error' in preflight) {
        return preflight.error
      }
      // Publish the script before any config can reference it.
      await writeManagedScriptRemote(sftp, scriptPath, getDroidManagedScript('posix'))

      const files = await readRemoteDroidHookFiles(sftp, hooksPath, settingsPath)
      if ('error' in files) {
        return files.error
      }
      const { settingsChanged } = applyDroidInstall(
        files,
        getDroidManagedCommand(scriptPath, 'posix'),
        'droid-hook.sh'
      )
      await writeDroidHookFileRemote(sftp, hooksPath, files.hooksFile)
      if (settingsChanged) {
        await writeDroidHookFileRemote(sftp, settingsPath, files.settings)
      }

      return {
        agent: 'droid',
        configPath: hooksPath,
        ...resolveDroidHookCoverage(
          files,
          getDroidManagedCommand(scriptPath, 'posix'),
          await orgAllowsManagedHooksOnlyRemote(sftp, platform)
        )
      }
    } catch (err) {
      return errorStatus(hooksPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const files = readDroidHookFiles()
    if ('error' in files) {
      return files.error
    }
    const { hooksChanged, settingsChanged } = applyDroidRemove(
      files,
      getDroidManagedScriptFileName()
    )
    if (hooksChanged) {
      writeHooksJson(getHooksJsonPath(), files.hooksFile, { preserveMode: true })
    }
    if (settingsChanged) {
      writeHooksJson(getSettingsJsonPath(), files.settings, { preserveMode: true })
    }
    return this.getStatus()
  }
}

export const droidHookService = new DroidHookService()
