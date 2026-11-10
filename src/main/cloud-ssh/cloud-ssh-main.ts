// Desktop wiring for SSH into Orca Cloud workspaces: the service singleton (the CLI's RPC and the
// window's IPC share it), editor detection, and the forward's activity/idle watch.
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { BUILT_IN_EDITOR_COMMANDS } from '../../shared/open-in-applications'
import { getRemoteSshEditorKind } from '../../shared/remote-ssh-editor-launcher'
import {
  CLOUD_SSH_REMOTE_PORT,
  type CloudSshEditor,
  type CloudSshOpenEditorRequest,
  type CloudSshOpenEditorResult,
  type CloudSshCopyResult,
  type CloudSshRevokeResult,
  type CloudSshStatus
} from '../../shared/cloud-ssh'
import type { OpenInApplication } from '../../shared/ui-chrome-types'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import {
  launchExternalEditor,
  resolveExternalEditorExecutable
} from '../external-editors/external-editor-launch'
import { getLauncherBaseName } from '../external-editors/editor-launcher-name'
import { getHostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-install'
import {
  getRuntimePortForwardManager,
  openRuntimePortForward
} from '../runtime-port-forward/runtime-port-forward-manager'
import { getRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { noteCloudSshActivity } from './cloud-ssh-activity'
import {
  addCloudSshInclude,
  cloudSshIncludeLine,
  readCloudSshIncludeState,
  removeCloudSshInclude
} from './cloud-ssh-include'
import { setCloudSshService } from './cloud-ssh-registry'
import { createCloudSshService, type CloudSshService } from './cloud-ssh-service'
import { cloudSshFailure } from './cloud-ssh-workspaces'

/** An SSH forward nobody has used for this long closes; the next `ssh` reopens it. */
const SSH_FORWARD_IDLE_CLOSE_MS = 10 * 60_000
const WATCH_INTERVAL_MS = 60_000

let service: CloudSshService | null = null

function userSshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

function abbreviateHome(text: string): string {
  const home = homedir()
  return home ? text.split(home).join('~') : text
}

/** VS Code and Cursor that are actually installed: saved Open In apps first, then the built-ins. */
export function detectCloudSshEditors(
  saved: readonly OpenInApplication[],
  resolve: (command: string) => string | null = (command) =>
    resolveExternalEditorExecutable(command)
): (CloudSshEditor & { executable: string })[] {
  const candidates: { id: string; label: string; command: string }[] = [
    ...saved,
    { id: 'builtin:vscode', label: 'VS Code', command: BUILT_IN_EDITOR_COMMANDS.vscode },
    { id: 'builtin:cursor', label: 'Cursor', command: BUILT_IN_EDITOR_COMMANDS.cursor }
  ]
  const found = new Map<string, CloudSshEditor & { executable: string }>()
  for (const candidate of candidates) {
    const executable = resolve(candidate.command)
    if (!executable || getRemoteSshEditorKind(executable) !== 'vscode-remote') {
      continue
    }
    const kind = getLauncherBaseName(executable) === 'cursor' ? 'cursor' : 'vscode'
    if (!found.has(kind)) {
      found.set(kind, { id: candidate.id, label: candidate.label, kind, executable })
    }
  }
  return [...found.values()]
}

const idleSince = new Map<string, number>()
let watchTimer: ReturnType<typeof setTimeout> | null = null

/** Watches SSH forwards only while one exists: their traffic keeps the VM awake, and one with no
 *  connection for 10 min closes. Stops by itself once no SSH forward is left. */
function watchSshForwards(): void {
  if (watchTimer) {
    return
  }
  watchTimer = setTimeout(() => {
    watchTimer = null
    const manager = getRuntimePortForwardManager()
    const forwards = (manager?.list() ?? []).filter((forward) => forward.reason === 'ssh')
    const now = Date.now()
    for (const forward of forwards) {
      // The forward's meter tells typing from keepalives (an idle VS Code window included).
      const usedAt = manager?.forwardLastUsedAt(forward.id) ?? null
      if (usedAt !== null && now - usedAt < WATCH_INTERVAL_MS) {
        noteCloudSshActivity(forward.environmentId, usedAt)
      }
      if (forward.openConnections > 0) {
        idleSince.delete(forward.id)
        continue
      }
      const since = idleSince.get(forward.id) ?? now
      idleSince.set(forward.id, since)
      if (now - since >= SSH_FORWARD_IDLE_CLOSE_MS) {
        manager?.close(forward.id)
        idleSince.delete(forward.id)
      }
    }
    if (manager?.list().some((forward) => forward.reason === 'ssh')) {
      watchSshForwards()
    }
  }, WATCH_INTERVAL_MS)
  watchTimer.unref?.()
}

export function installCloudSsh(store: Store): void {
  // Handlers re-register with the window's IPC; the service and its watch start once.
  registerCloudSshHandlers(store)
  if (service) {
    return
  }
  const userDataPath = app.getPath('userData')
  service = createCloudSshService({
    userDataPath,
    deviceName: hostname().replace(/\.local$/i, ''),
    listRuntimes: () => listEphemeralVmRuntimes(userDataPath),
    controlPlane: getHostedSandboxControlPlaneClient,
    wake: async (runtimeEnvironmentId) => {
      const waker = getRecipeVmWaker()
      if (waker) {
        await waker.openEnvironment(runtimeEnvironmentId)
      }
    },
    openForward: async (runtimeEnvironmentId) => {
      const forward = await openRuntimePortForward({
        environmentId: runtimeEnvironmentId,
        remotePort: CLOUD_SSH_REMOTE_PORT,
        localPort: 0,
        reason: 'ssh',
        label: 'SSH'
      })
      if (forward.ok) {
        watchSshForwards()
      }
      return forward
    },
    cliCommand: () =>
      prependOrcaCliDirToChildPath(
        {},
        { isPackaged: app.isPackaged, userDataPath, resourcesPath: process.resourcesPath }
      )
  })
  setCloudSshService(service)
  void service.prune()
}

function registerCloudSshHandlers(store: Store): void {
  const editors = (): ReturnType<typeof detectCloudSshEditors> =>
    detectCloudSshEditors(store.getSettings().openInApplications ?? [])

  ipcMain.removeHandler('cloudSsh:status')
  ipcMain.handle(
    'cloudSsh:status',
    async (_event, args: { workspaceId: string }): Promise<CloudSshStatus> => {
      const none: CloudSshStatus = {
        cloud: false,
        hasAccess: false,
        asleep: false,
        alias: null,
        includeInstalled: false,
        editors: []
      }
      if (!service) {
        return none
      }
      try {
        const status = await service.status(args.workspaceId)
        if (!status.cloud) {
          return none
        }
        return {
          ...status,
          includeInstalled: await readCloudSshIncludeState(
            userSshConfigPath(),
            service.paths.configFile
          ).catch(() => false),
          editors: editors().map(({ id, label, kind }) => ({ id, label, kind }))
        }
      } catch (error) {
        console.warn('[cloud-ssh] status failed', error)
        return none
      }
    }
  )

  ipcMain.removeHandler('cloudSsh:copyCommand')
  ipcMain.handle(
    'cloudSsh:copyCommand',
    async (_event, args: { workspaceId: string }): Promise<CloudSshCopyResult> => {
      try {
        const access = await service!.prepare(args.workspaceId)
        // With Orca's Include in ~/.ssh/config the alias alone resolves.
        const included = await readCloudSshIncludeState(
          userSshConfigPath(),
          access.configFile
        ).catch(() => false)
        const command = included ? `ssh ${access.alias}` : access.command
        clipboard.writeText(command)
        return { ok: true, command, displayCommand: abbreviateHome(command) }
      } catch (error) {
        return cloudSshFailure(error)
      }
    }
  )

  ipcMain.removeHandler('cloudSsh:openInEditor')
  ipcMain.handle(
    'cloudSsh:openInEditor',
    async (_event, args: CloudSshOpenEditorRequest): Promise<CloudSshOpenEditorResult> => {
      try {
        const editor = editors().find((candidate) => candidate.id === args.editorId)
        if (!editor) {
          return { ok: false, code: 'editor_missing', message: 'That editor is not installed.' }
        }
        const userConfig = userSshConfigPath()
        const configFile = service!.paths.configFile
        // Remote-SSH resolves the host from ~/.ssh/config; ask before adding the one Include line.
        const included = await readCloudSshIncludeState(userConfig, configFile).catch(() => false)
        if (!included && !args.allowSshConfigInclude) {
          return {
            ok: false,
            code: 'include_required',
            includeLine: cloudSshIncludeLine(configFile)
          }
        }
        const access = await service!.prepare(args.workspaceId)
        if (!included) {
          await addCloudSshInclude(userConfig, configFile)
        }
        // A folder URI keeps the path out of the editor launcher's argument parsing (code.cmd
        // runs through cmd.exe on Windows); the root is a VM path Orca recorded, checked anyway.
        if (!/^\/[^\0\r\n"%]*$/.test(access.projectRoot)) {
          return { ok: false, code: 'control_plane', message: 'Unexpected workspace path.' }
        }
        const spawnArgs = [
          '--folder-uri',
          `vscode-remote://ssh-remote+${access.alias}${access.projectRoot
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`
        ]
        // Cursor may reuse the last workbench; a new window keeps this workspace's target.
        if (editor.kind === 'cursor') {
          spawnArgs.unshift('--new-window')
        }
        await launchExternalEditor({
          kind: 'executable',
          hideWindowsConsole: true,
          spawnCmd: editor.executable,
          spawnArgs
        })
        return { ok: true }
      } catch (error) {
        return cloudSshFailure(error)
      }
    }
  )

  ipcMain.removeHandler('cloudSsh:revoke')
  ipcMain.handle(
    'cloudSsh:revoke',
    async (_event, args: { workspaceId: string }): Promise<CloudSshRevokeResult> => {
      try {
        const result = await service!.revoke(args.workspaceId)
        return { ok: true, ...result }
      } catch (error) {
        return cloudSshFailure(error)
      }
    }
  )

  ipcMain.removeHandler('cloudSsh:removeSshConfigInclude')
  ipcMain.handle('cloudSsh:removeSshConfigInclude', async (): Promise<boolean> => {
    if (!service) {
      return false
    }
    try {
      await removeCloudSshInclude(userSshConfigPath(), service.paths.configFile)
      return true
    } catch (error) {
      console.warn('[cloud-ssh] removing the Include failed', error)
      return false
    }
  })
}
