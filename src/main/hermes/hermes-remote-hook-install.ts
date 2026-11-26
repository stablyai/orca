import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  listRemoteDirectory,
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installation/remote/hook-text-files-remote'
import { installOrcaStatusContent, refreshProfileOrcaStatusContent } from './hermes-config-yaml'
import { UNMANAGED_HERMES_PLUGIN_DETAIL } from './hermes-home-filesystem'
import {
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

type RemotePluginFiles = {
  manifest: string | null
  init: string | null
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

async function readRemotePluginFiles(
  sftp: SFTPWrapper,
  pluginDir: string
): Promise<RemotePluginFiles> {
  const [manifest, init] = await Promise.all([
    readTextFileRemote(sftp, `${pluginDir}/plugin.yaml`),
    readTextFileRemote(sftp, `${pluginDir}/__init__.py`)
  ])
  return { manifest, init }
}

function hasUnmanagedRemotePluginFile(files: RemotePluginFiles): boolean {
  return (
    (files.manifest !== null && !files.manifest.includes(HERMES_PLUGIN_MARKER)) ||
    (files.init !== null && !files.init.includes(HERMES_PLUGIN_MARKER))
  )
}

async function writeRemotePluginFiles(
  sftp: SFTPWrapper,
  pluginDir: string,
  existing: RemotePluginFiles
): Promise<void> {
  const manifestPath = `${pluginDir}/plugin.yaml`
  const initPath = `${pluginDir}/__init__.py`
  const manifestWritten = await writeTextFileRemoteAtomic(sftp, manifestPath, getPluginManifest(), {
    computedFrom: existing.manifest
  })
  if (!manifestWritten) {
    throw new Error(`${manifestPath} changed while Orca updated it`)
  }
  const initWritten = await writeTextFileRemoteAtomic(sftp, initPath, getPluginInitSource(), {
    computedFrom: existing.init
  })
  if (!initWritten) {
    throw new Error(`${initPath} changed while Orca updated it`)
  }
}

async function updateRemoteConfigAtomic(
  sftp: SFTPWrapper,
  configPath: string,
  compute: (existing: string | null) => { content: string | null; detail?: string },
  initial?: { existing: string | null; next: { content: string | null; detail?: string } }
): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (let attempt = 0; ; attempt++) {
    const existing =
      attempt === 0 && initial !== undefined
        ? initial.existing
        : await readTextFileRemote(sftp, configPath)
    const next = attempt === 0 && initial !== undefined ? initial.next : compute(existing)
    if (next.content === null) {
      return { ok: false, detail: next.detail ?? 'unknown error' }
    }
    if (next.content === existing) {
      return { ok: true }
    }
    // A save after the read is kept; redo the edit on it.
    if (
      await writeTextFileRemoteAtomic(sftp, configPath, next.content, { computedFrom: existing })
    ) {
      return { ok: true }
    }
    if (attempt === 2) {
      throw new Error(`${configPath} kept changing while Orca updated it`)
    }
  }
}

async function installRemoteManagedProfiles(sftp: SFTPWrapper, profilesDir: string): Promise<void> {
  const names = await listRemoteDirectory(sftp, profilesDir).catch((error: unknown) => {
    console.warn(`[hermes] could not list remote profiles in ${profilesDir}:`, error)
    return null
  })
  for (const name of names ?? []) {
    const home = `${profilesDir}/${name}`
    const pluginDir = `${home}/plugins/${HERMES_PLUGIN_NAME}`
    try {
      const existingPlugin = await readRemotePluginFiles(sftp, pluginDir)
      if (
        !existingPlugin.manifest?.includes(HERMES_PLUGIN_MARKER) ||
        !existingPlugin.init?.includes(HERMES_PLUGIN_MARKER)
      ) {
        continue
      }
      const configPath = `${home}/config.yaml`
      const existing = await readTextFileRemote(sftp, configPath)
      const next = refreshProfileOrcaStatusContent(existing)
      if (next.content !== null) {
        await writeRemotePluginFiles(sftp, pluginDir, existingPlugin)
        await updateRemoteConfigAtomic(sftp, configPath, refreshProfileOrcaStatusContent, {
          existing,
          next
        })
      }
    } catch (error) {
      console.warn(`[hermes] skipped remote profile ${home}:`, error)
    }
  }
}

export async function installHermesHooksRemote(
  sftp: SFTPWrapper,
  remoteHome: string
): Promise<AgentHookInstallStatus> {
  const remoteRoot = stripTrailingSlash(remoteHome)
  const remoteHermesHome = `${remoteRoot}/.hermes`
  const remoteConfigPath = `${remoteHermesHome}/config.yaml`
  const remotePluginDir = `${remoteHermesHome}/plugins/${HERMES_PLUGIN_NAME}`
  // Why: config contention throws after both plugin files landed; status must still report them.
  let pluginFilesWritten = false
  try {
    const existingPlugin = await readRemotePluginFiles(sftp, remotePluginDir)
    if (hasUnmanagedRemotePluginFile(existingPlugin)) {
      return {
        agent: 'hermes',
        state: 'partial',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: UNMANAGED_HERMES_PLUGIN_DETAIL
      }
    }
    const existing = await readTextFileRemote(sftp, remoteConfigPath)
    const next = installOrcaStatusContent(existing)
    if (next.content === null) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: `Could not parse remote Hermes config.yaml: ${next.detail ?? 'unknown error'}`
      }
    }
    await writeRemotePluginFiles(sftp, remotePluginDir, existingPlugin)
    pluginFilesWritten = true
    const updated = await updateRemoteConfigAtomic(
      sftp,
      remoteConfigPath,
      installOrcaStatusContent,
      { existing, next }
    )
    if (!updated.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: `Could not parse remote Hermes config.yaml: ${updated.detail}`
      }
    }
    await installRemoteManagedProfiles(sftp, `${remoteHermesHome}/profiles`)
    return {
      agent: 'hermes',
      state: 'installed',
      configPath: remoteConfigPath,
      managedHooksPresent: true,
      detail: null
    }
  } catch (error) {
    return {
      agent: 'hermes',
      state: 'error',
      configPath: remoteConfigPath,
      managedHooksPresent: pluginFilesWritten,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
