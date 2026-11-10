import { join, posix } from 'node:path'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { isSafePluginRelativePath } from '../../shared/plugins/installation/plugin-path-safety'
import { isPluginJsonObject } from '../../shared/plugins/manifest/plugin-json-object'
import type { PluginWorkerController } from './workers/plugin-worker-controller'
import { runPluginReplacementWithinDeadline } from './plugin-command-replacement-deadline'
import {
  pluginWorkspaceCommandRequestSchema,
  type PluginWorkspaceCommandArgs
} from '../../shared/plugins/contributions/plugin-workspace-command-args'

/** Resolves the workspace a user ran a workspace command on; null when this host can't reach it. */
export type PluginCommandWorkspaceResolver = (
  worktreeId: string
) => Promise<PluginWorkspaceCommandArgs['worktree'] | null>

type PluginCommand = ValidDiscoveredPlugin['manifest']['contributes']['commands'][number]

export function assertPluginWorkerCommand(
  plugin: ValidDiscoveredPlugin,
  commandId: string
): PluginCommand {
  const command = plugin.manifest.contributes.commands.find((entry) => entry.id === commandId)
  if (!command) {
    throw new Error(`plugin ${plugin.pluginKey} does not contribute command ${commandId}`)
  }
  // Renderer-owned action aliases cannot activate workers, even through direct IPC.
  if (command.action !== undefined) {
    throw new Error(`plugin ${plugin.pluginKey} command ${commandId} is a built-in action alias`)
  }
  return command
}

/** Args a client built as a workspace request: `worktreeId`, and at most `folder` beside it. */
function isWorkspaceCommandRequestShape(args: unknown): boolean {
  return (
    isPluginJsonObject(args) &&
    'worktreeId' in args &&
    Object.keys(args).every((key) => key === 'worktreeId' || key === 'folder')
  )
}

/** The args the handler receives: a `{ worktreeId, folder? }` request becomes the workspace, and
 *  the subfolder, it names. */
export async function workerCommandArgs(
  plugin: ValidDiscoveredPlugin,
  command: PluginCommand,
  args: unknown,
  resolveWorkspace: PluginCommandWorkspaceResolver | undefined
): Promise<unknown> {
  if (!isWorkspaceCommandRequestShape(args)) {
    return args
  }
  const request = pluginWorkspaceCommandRequestSchema.safeParse(args)
  // Why refuse, not pass through: a malformed request still carries the id and its path.
  if (!request.success) {
    throw new Error('Invalid workspace command request.')
  }
  const canReadWorkspace = plugin.manifest.capabilities.some(
    (capability) => capability.kind === 'workspace:read'
  )
  // Why: worktree ids embed the folder path, so a request is never forwarded as-is; only a
  // workspace command of a plugin granted workspace:read learns the folder.
  if (command.when !== 'workspace' || !canReadWorkspace) {
    return undefined
  }
  const worktree = await resolveWorkspace?.(request.data.worktreeId)
  if (!worktree) {
    throw new Error('This workspace is not available on this computer.')
  }
  const { folder } = request.data
  if (!folder) {
    return { worktree } satisfies PluginWorkspaceCommandArgs
  }
  if (!isSafePluginRelativePath(folder)) {
    throw new Error('That folder is not inside this workspace.')
  }
  const relativePath = folder.replaceAll('\\', '/')
  // Why posix for SSH: the remote path is POSIX even when this computer runs Windows.
  const path = (worktree.host === 'ssh' ? posix.join : join)(worktree.path, relativePath)
  return { worktree, folder: { path, relativePath } } satisfies PluginWorkspaceCommandArgs
}

/** `run.plugin` is the approved plugin (null when it is not): a palette or CLI run of its command. */
export async function invokePluginWorkerCommand(
  pluginKey: string,
  run: { plugin: ValidDiscoveredPlugin | null; workers: Pick<PluginWorkerController, 'ensure'> },
  commandId: string,
  args?: unknown,
  /** Epoch ms past which the caller stopped waiting, so a slow start must not run it late. */
  startBy?: number,
  runtime?: { resolveCommandWorkspace?: PluginCommandWorkspaceResolver } | null
): Promise<unknown> {
  const { plugin, workers } = run
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  const command = assertPluginWorkerCommand(plugin, commandId)
  const input = await workerCommandArgs(plugin, command, args, runtime?.resolveCommandWorkspace)
  const handle = await workers.ensure(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
  }
  if (startBy !== undefined && Date.now() > startBy) {
    throw new Error(`plugin ${pluginKey} started too late to run ${commandId}`)
  }
  if (startBy !== undefined && command.replaces !== undefined) {
    // Why: past startBy the renderer runs Orca's own action, so a handler that finishes later
    // must not run it again through commands.run.
    return runPluginReplacementWithinDeadline(pluginKey, command.replaces, startBy, () =>
      handle.invokeCommand(commandId, input)
    )
  }
  return handle.invokeCommand(commandId, input)
}
