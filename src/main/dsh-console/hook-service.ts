import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import {
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { hasDshConsolePatch, updateDshConsolePatch } from './profile-patch'
import {
  DSH_CONSOLE_STATUS_PLUGIN_FILE,
  DSH_CONSOLE_STATUS_PLUGIN_MARKER,
  getDshConsoleStatusPluginSource
} from './status-plugin-source'

const localUpdates = new Map<string, Promise<void>>()

const MANAGED_MANIFEST = '{"private":true,"orcaManaged":"dsh-console-status-v1"}\n'

type BridgeFilesystem = {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}
const localFilesystem: BridgeFilesystem = {
  async read(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  },
  async write(path, content) {
    if ((await this.read(path)) === content) {
      return
    }
    await mkdir(dirname(path), { recursive: true })
    const mode = await stat(path).then(
      (value) => value.mode & 0o777,
      () => 0o600
    )
    await writePluginFileAtomically(path, content, { mode })
  },
  async remove(path) {
    await rm(path, { force: true })
  }
}

function localProfile(): string {
  const configured = process.env.DSH_HOME
  return join(configured?.trim() ? configured : join(homedir(), '.dsh'), 'profiles', 'dsh-console')
}
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}
function status(
  configPath: string,
  patch: string | null,
  plugin: string | null,
  manifest: string | null
): AgentHookInstallStatus {
  const managed = plugin?.startsWith(`// ${DSH_CONSOLE_STATUS_PLUGIN_MARKER}\n`) ?? false
  const enabled = hasDshConsolePatch(patch)
  return {
    agent: 'dsh-console',
    configPath,
    managedHooksPresent: managed,
    state:
      managed && enabled && manifest === MANAGED_MANIFEST
        ? 'installed'
        : !plugin && !enabled && !manifest
          ? 'not_installed'
          : 'partial',
    detail:
      plugin && !managed
        ? 'Existing orca-status/index.mjs is not managed by Orca'
        : manifest && manifest !== MANAGED_MANIFEST
          ? 'Existing bridge manifest is not managed by Orca'
          : null
  }
}
function failure(configPath: string, error: unknown): AgentHookInstallStatus {
  return {
    agent: 'dsh-console',
    state: 'error',
    configPath,
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

export class DshConsoleHookService {
  getStatus(): AgentHookInstallStatus {
    const profile = localProfile()
    const configPath = join(profile, 'cordis.patch.yml')
    try {
      return status(
        configPath,
        readOptional(configPath),
        readOptional(join(profile, DSH_CONSOLE_STATUS_PLUGIN_FILE)),
        readOptional(join(profile, 'orca-status/package.json'))
      )
    } catch (error) {
      return failure(configPath, error)
    }
  }

  install(): Promise<AgentHookInstallStatus> {
    const profile = localProfile()
    return runKeyedSerializedOperation(localUpdates, profile, () =>
      this.update(localFilesystem, profile, true)
    )
  }

  remove(): Promise<AgentHookInstallStatus> {
    const profile = localProfile()
    return runKeyedSerializedOperation(localUpdates, profile, () =>
      this.update(localFilesystem, profile, false)
    )
  }

  installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    dshHomeDir?: string
  ): Promise<AgentHookInstallStatus> {
    const root = dshHomeDir || `${remoteHome.replace(/\/+$/, '')}/.dsh`
    return this.update(
      {
        read: (path) => readTextFileRemote(sftp, path),
        write: (path, content) => writeTextFileRemoteAtomic(sftp, path, content),
        remove: (path) =>
          new Promise<void>((resolve, reject) => {
            sftp.unlink(path, (error) => (error ? reject(error) : resolve()))
          })
      },
      `${root.replace(/\/+$/, '')}/profiles/dsh-console`,
      true
    )
  }

  private async update(
    filesystem: BridgeFilesystem,
    profile: string,
    enabled: boolean
  ): Promise<AgentHookInstallStatus> {
    const configPath = `${profile}/cordis.patch.yml`
    const pluginPath = `${profile}/${DSH_CONSOLE_STATUS_PLUGIN_FILE}`
    try {
      const patch = await filesystem.read(configPath)
      const plugin = await filesystem.read(pluginPath)
      if (plugin !== null && !plugin.startsWith(`// ${DSH_CONSOLE_STATUS_PLUGIN_MARKER}\n`)) {
        throw new Error('Refusing to overwrite an unmanaged DSH Console orca-status/index.mjs')
      }
      const manifestPath = `${profile}/orca-status/package.json`
      const manifest = await filesystem.read(manifestPath)
      if (manifest !== null && manifest !== MANAGED_MANIFEST) {
        throw new Error('Refusing to overwrite an unmanaged DSH Console bridge manifest')
      }
      const next = updateDshConsolePatch(patch, enabled)
      if (enabled) {
        await filesystem.write(manifestPath, MANAGED_MANIFEST)
        await filesystem.write(pluginPath, getDshConsoleStatusPluginSource())
      }
      if (next !== patch && (enabled || patch !== null)) {
        await filesystem.write(configPath, next)
      }
      if (!enabled && plugin !== null) {
        await filesystem.remove(pluginPath)
      }
      if (!enabled && manifest !== null) {
        await filesystem.remove(manifestPath)
      }
      return {
        ...status(
          configPath,
          next,
          enabled ? getDshConsoleStatusPluginSource() : null,
          enabled ? MANAGED_MANIFEST : null
        ),
        managedHooksPresent: enabled
      }
    } catch (error) {
      return failure(configPath, error)
    }
  }
}
export const dshConsoleHookService = new DshConsoleHookService()
