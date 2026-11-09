// SSH into Orca Cloud workspaces: the VM's sshd is on its loopback only, so `orca ssh-proxy` has
// this app wake the VM, install this device's key and open the runtime port forward. The VM host
// key comes from the control plane and is pinned, never trusted on first use.
import { readFile } from 'node:fs/promises'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-control-plane-client'
import {
  cloudSshAlias,
  cloudSshCommandLine,
  cloudSshKeyComment,
  renderCloudSshConfig,
  renderCloudSshKnownHosts,
  type CloudSshHostEntry
} from './cloud-ssh-config'
import { generateCloudSshKeyPair } from './cloud-ssh-keygen'
import { installVmKey, removeStaleVmKeys } from './cloud-ssh-vm-keys'
import {
  cloudSshKeyFile,
  cloudSshPaths,
  ensureCloudSshDirs,
  readCloudSshState,
  removeCloudSshKeyFiles,
  writeCloudSshState,
  writePrivateFile,
  type CloudSshEntry,
  type CloudSshPaths,
  type CloudSshState
} from './cloud-ssh-store'
import {
  CloudSshError,
  controlPlaneError,
  listCloudWorkspaces,
  resolveCloudWorkspace,
  type CloudWorkspace
} from './cloud-ssh-workspaces'

export type CloudSshServiceDeps = {
  userDataPath: string
  deviceName: string
  listRuntimes: () => readonly EphemeralVmRuntimeRecord[]
  controlPlane: () => HostedSandboxControlPlaneClient | null
  /** Holds until the workspace's VM is up (waking it), or throws why it cannot be. */
  wake: (runtimeEnvironmentId: string) => Promise<void>
  openForward: (
    runtimeEnvironmentId: string
  ) => Promise<{ ok: true; localPort: number } | { ok: false; code: string; message: string }>
  /** The `orca` launcher ProxyCommand runs; null when this build has none. */
  cliCommand: () => string | null
  now?: () => number
}

export type CloudSshAccess = {
  alias: string
  configFile: string
  command: string
  projectRoot: string
}

export type CloudSshService = ReturnType<typeof createCloudSshService>

export function createCloudSshService(deps: CloudSshServiceDeps) {
  const paths: CloudSshPaths = cloudSshPaths(deps.userDataPath)
  const now = deps.now ?? Date.now
  // One access change at a time: key creation, install and file rewrites must not interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  const cloudWorkspaces = (): CloudWorkspace[] => listCloudWorkspaces(deps.listRuntimes())

  async function resolve(selector: string): Promise<CloudWorkspace> {
    const { entries } = await readCloudSshState(paths)
    return resolveCloudWorkspace(
      deps.listRuntimes(),
      selector,
      (alias) => entries.find((entry) => entry.alias === alias)?.runtimeId
    )
  }

  function hostEntries(entries: readonly CloudSshEntry[]): CloudSshHostEntry[] {
    return entries.flatMap((entry) =>
      entry.hostKey && entry.user && entry.port
        ? [
            {
              alias: entry.alias,
              identityFile: cloudSshKeyFile(paths, entry.alias),
              user: entry.user,
              port: entry.port,
              hostKey: entry.hostKey,
              proxyTarget: entry.runtimeId
            }
          ]
        : []
    )
  }

  /** Rewrites state, config and known_hosts, dropping workspaces that no longer exist. */
  async function writeFiles(state: CloudSshState): Promise<CloudSshEntry[]> {
    const live = new Set(cloudWorkspaces().map((ws) => ws.runtimeId))
    const kept: CloudSshEntry[] = []
    for (const entry of state.entries) {
      if (live.has(entry.runtimeId)) {
        kept.push(entry)
      } else {
        await removeCloudSshKeyFiles(paths, entry.alias)
      }
    }
    const staleKeys = state.staleKeys.filter((stale) => live.has(stale.runtimeId))
    const cli = deps.cliCommand()
    if (!cli) {
      throw new CloudSshError(
        'cli_missing',
        'The orca command is not available in this build, so ssh cannot reach the workspace.'
      )
    }
    const hosts = hostEntries(kept)
    await writeCloudSshState(paths, { entries: kept, staleKeys })
    await writePrivateFile(paths.knownHostsFile, renderCloudSshKnownHosts(hosts))
    await writePrivateFile(
      paths.configFile,
      renderCloudSshConfig({
        entries: hosts,
        knownHostsFile: paths.knownHostsFile,
        cliCommand: cli,
        userDataPath: process.platform === 'win32' ? undefined : deps.userDataPath
      })
    )
    return kept
  }

  // VM boot each key was last confirmed on (the runtime record changes on every resume). A wiped
  // or rolled-over disk, or a dead sshd, is then repaired by the next connection, not cached forever.
  const confirmedBoot = new Map<string, number>()

  async function wake(ws: CloudWorkspace): Promise<void> {
    try {
      await deps.wake(ws.runtimeEnvironmentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CloudSshError('wake_failed', message || 'The workspace could not be woken up.')
    }
  }

  async function installedEntry(ws: CloudWorkspace): Promise<CloudSshEntry | null> {
    const entry = (await readCloudSshState(paths)).entries.find(
      (candidate) => candidate.runtimeId === ws.runtimeId
    )
    if (!entry?.installedAt || !entry.hostKey) {
      return null
    }
    const keyPresent = await readFile(cloudSshKeyFile(paths, entry.alias), 'utf8').then(
      Boolean,
      () => false
    )
    return keyPresent ? entry : null
  }

  /**
   * Creates this device's key on first use and installs it in the VM, waking the VM only when
   * that install is needed (or the caller is about to connect): copying a command for a sleeping
   * workspace that already has access costs nothing.
   */
  async function ensureAccess(
    selector: string,
    options: { wake: 'always' | 'if-needed' }
  ): Promise<{ ws: CloudWorkspace; entry: CloudSshEntry }> {
    const resolved = await resolve(selector)
    const ready = await installedEntry(resolved)
    const awake = options.wake === 'always' || !ready
    if (awake) {
      await wake(resolved)
    }
    // Re-read after the wake: the record now describes the VM's current boot.
    const ws = awake ? await resolve(resolved.runtimeId) : resolved
    const reconfirm = awake && confirmedBoot.get(ws.runtimeId) !== ws.runtime.updatedAt
    return serialized(async () => {
      await ensureCloudSshDirs(paths)
      const state = await readCloudSshState(paths)
      const { entries } = state
      let entry = entries.find((candidate) => candidate.runtimeId === ws.runtimeId)
      const keyFile = entry ? cloudSshKeyFile(paths, entry.alias) : null
      const keyPresent = keyFile
        ? await readFile(keyFile, 'utf8').then(Boolean, () => false)
        : false
      if (!entry || !keyPresent) {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(ws.runtimeId)) {
          throw new CloudSshError('not_found', 'This workspace has an id SSH cannot use.')
        }
        const taken = new Set(entries.map((candidate) => candidate.alias))
        let alias = entry?.alias ?? cloudSshAlias(ws.runtime.workspaceName, ws.sandboxId)
        for (let n = 2; !entry && taken.has(alias); n++) {
          alias = `${cloudSshAlias(ws.runtime.workspaceName, ws.sandboxId)}-${n}`
        }
        const pair = generateCloudSshKeyPair(cloudSshKeyComment(deps.deviceName, alias))
        await writePrivateFile(cloudSshKeyFile(paths, alias), pair.privateKey)
        await writePrivateFile(`${cloudSshKeyFile(paths, alias)}.pub`, `${pair.publicKey}\n`)
        entry = {
          alias,
          runtimeId: ws.runtimeId,
          sandboxId: ws.sandboxId,
          workspaceName: ws.runtime.workspaceName,
          publicKey: pair.publicKey,
          createdAt: now()
        }
      }
      if (reconfirm || !keyPresent || !entry.installedAt || !entry.hostKey) {
        // Idempotent: also restarts sshd and answers the current host key, which is re-pinned.
        const access = await installVmKey(deps.controlPlane(), ws.sandboxId, entry.publicKey)
        confirmedBoot.set(ws.runtimeId, ws.runtime.updatedAt)
        entry = {
          ...entry,
          user: access.user,
          port: access.port,
          hostKey: access.hostKey,
          installedAt: now()
        }
      }
      const others = entries.filter((candidate) => candidate.runtimeId !== ws.runtimeId)
      const staleKeys = awake
        ? await removeStaleVmKeys(deps.controlPlane(), ws.runtimeId, state.staleKeys)
        : state.staleKeys
      const kept = await writeFiles({ entries: [...others, entry], staleKeys })
      return { ws, entry: kept.find((candidate) => candidate.runtimeId === ws.runtimeId)! }
    })
  }

  return {
    paths,

    /** For the menu: whether SSH applies, and whether this device already has access. */
    async status(
      workspaceId: string
    ): Promise<{ cloud: boolean; hasAccess: boolean; asleep: boolean; alias: string | null }> {
      const ws = cloudWorkspaces().find(
        (candidate) => candidate.runtime.workspaceId === workspaceId
      )
      if (!ws) {
        return { cloud: false, hasAccess: false, asleep: false, alias: null }
      }
      const entry = (await readCloudSshState(paths)).entries.find(
        (candidate) => candidate.runtimeId === ws.runtimeId
      )
      return {
        cloud: true,
        hasAccess: Boolean(entry?.installedAt),
        asleep: ws.runtime.status === 'suspended' || ws.runtime.status === 'resume_failed',
        alias: entry?.alias ?? null
      }
    },

    /** "Copy SSH command", `orca ssh`, "Open in VS Code": this device can log in once ssh runs. */
    async prepare(selector: string): Promise<CloudSshAccess> {
      const { ws, entry } = await ensureAccess(selector, { wake: 'if-needed' })
      return {
        alias: entry.alias,
        configFile: paths.configFile,
        command: cloudSshCommandLine(paths.configFile, entry.alias),
        projectRoot: ws.projectRoot
      }
    },

    /** `orca ssh-proxy`: wake, make sure of the key (installed once), open the loopback forward. */
    async tunnel(selector: string): Promise<{ port: number; runtimeEnvironmentId: string }> {
      const { ws } = await ensureAccess(selector, { wake: 'always' })
      const forward = await deps.openForward(ws.runtimeEnvironmentId)
      if (!forward.ok) {
        throw new CloudSshError('forward_failed', forward.message)
      }
      return { port: forward.localPort, runtimeEnvironmentId: ws.runtimeEnvironmentId }
    },

    /** Removes this device's key from the VM (waking it) and deletes it here. If the VM cannot
     *  be reached, the key is still deleted here and its VM copy is removed on the next wake. */
    async revoke(workspaceId: string): Promise<{ removedFromWorkspace: boolean }> {
      const ws = await resolve(workspaceId)
      const hasEntry = (await readCloudSshState(paths)).entries.some(
        (candidate) => candidate.runtimeId === ws.runtimeId
      )
      // Nothing of this device's to remove: never wake (and bill) a VM for that.
      const woke = hasEntry
        ? await wake(ws).then(
            () => true,
            () => false
          )
        : false
      return serialized(async () => {
        const state = await readCloudSshState(paths)
        const entry = state.entries.find((candidate) => candidate.runtimeId === ws.runtimeId)
        if (!entry) {
          return { removedFromWorkspace: true }
        }
        let removedFromWorkspace = false
        const client = deps.controlPlane()
        try {
          if (client && woke) {
            await client.removeSshKey(ws.sandboxId, entry.publicKey)
            removedFromWorkspace = true
          }
        } catch (error) {
          // Asleep again already: the queued removal below runs on the next SSH wake.
          if (!isEnvironmentProviderError(error, 'conflict')) {
            throw controlPlaneError(error)
          }
        }
        await removeCloudSshKeyFiles(paths, entry.alias)
        await writeFiles({
          entries: state.entries.filter((candidate) => candidate !== entry),
          staleKeys: removedFromWorkspace
            ? state.staleKeys
            : [
                ...state.staleKeys,
                { runtimeId: ws.runtimeId, sandboxId: ws.sandboxId, publicKey: entry.publicKey }
              ]
        })
        return { removedFromWorkspace }
      })
    },

    /** Drops files for workspaces that are gone (destroyed or forgotten). */
    async prune(): Promise<void> {
      const state = await readCloudSshState(paths)
      if (state.entries.length > 0 || state.staleKeys.length > 0) {
        await serialized(() => writeFiles(state)).catch(() => undefined)
      }
    }
  }
}
