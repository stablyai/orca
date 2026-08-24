import { access, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import { isRepoManagedProjectGroup } from '../../shared/repo-managed-project'
import { runProcess } from '../../shared/child-process/run-process'
import { parseWslPath } from '../wsl'
import { toLinuxPath } from '../../shared/wsl-paths'
import { buildWslExecArgs, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { gitExecFileAsync } from '../git/runner'
import { computeWorktreePathAsync, sanitizeWorktreeName } from '../ipc/worktree-logic'
import {
  buildRepoInitArgs,
  buildRepoSyncArgs,
  readRepoManagedCheckoutIdentity,
  type RepoManagedCheckoutIdentity
} from './repo-managed-checkout'
import { resolveRepoProgram } from './repo-managed-cli'
import {
  REPO_MANAGED_LOCAL_OBJECTS_MISSING,
  seedDerivedRepoProjectGitDirs,
  type RepoManagedSeedProgress
} from './repo-managed-seed'
import type { RepoManagedDerivePhase } from '../../shared/repo-managed-derive-progress'
export type { RepoManagedDerivePhase } from '../../shared/repo-managed-derive-progress'
export { REPO_MANAGED_LOCAL_OBJECTS_MISSING, seedDerivedRepoProjectGitDirs }

export const REPO_MANAGED_DERIVE_SSH_UNSUPPORTED =
  'Deriving a repo workspace on SSH requires an Orca runtime on that host.'
export const REPO_TOOL_MISSING =
  'The repo CLI was not found. Install it from the workspace composer, or open a checkout that contains .repo/repo.'
export const REPO_MANAGED_GROUP_REQUIRED = 'Selected project is not a repo-managed checkout.'

const REPO_COMMAND_TIMEOUT_MS = 60 * 60 * 1000

export type RepoManagedCommandRunner = (args: {
  program: string
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

export type RepoManagedDeriveStore = {
  getSettings: () => { nestWorkspaces: boolean; workspaceDir: string }
  getProjectGroups: () => ProjectGroup[]
  createFolderWorkspace: (input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    linkedTask?: FolderWorkspace['linkedTask']
    linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
    creatorProvenance?: FolderWorkspace['creatorProvenance']
  }) => FolderWorkspace
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function formatRepoCommandFailure(action: string, stderr: string, stdout: string): string {
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(0, 4000)
  return detail ? `repo ${action} failed:\n${detail}` : `repo ${action} failed`
}

export async function defaultRepoCommandRunner(args: {
  program: string
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const wsl = parseWslPath(args.cwd)
  if (wsl) {
    const linuxCwd = wsl.linuxPath
    const command = [
      `cd ${quotePosixShell(linuxCwd)}`,
      `exec ${[toLinuxPath(args.program), ...args.args].map(quotePosixShell).join(' ')}`
    ].join('\n')
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(wsl.distro, ['/bin/bash', '-s', '--']),
      input: command,
      cwd: undefined,
      timeoutMs: REPO_COMMAND_TIMEOUT_MS,
      signal: args.signal
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const result = await runProcess({
    program: args.program,
    args: args.args,
    cwd: args.cwd,
    timeoutMs: REPO_COMMAND_TIMEOUT_MS,
    signal: args.signal
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

async function readIdentityFromCheckout(mainPath: string): Promise<RepoManagedCheckoutIdentity> {
  const git = {
    configGet: async (gitDir: string, key: string): Promise<string | null> => {
      try {
        const { stdout } = await gitExecFileAsync(['--git-dir', gitDir, 'config', '--get', key], {
          cwd: mainPath
        })
        return stdout
      } catch {
        return null
      }
    },
    abbrevRef: async (gitDir: string): Promise<string | null> => {
      try {
        const { stdout } = await gitExecFileAsync(
          ['--git-dir', gitDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: mainPath }
        )
        return stdout
      } catch {
        return null
      }
    }
  }
  return readRepoManagedCheckoutIdentity({
    mainPath,
    git,
    paths: {
      join,
      basename,
      realpath,
      exists: pathExists
    }
  })
}

async function removeDerivedPath(path: string): Promise<void> {
  const wsl = parseWslPath(path)
  if (!wsl) {
    await rm(path, { recursive: true, force: true })
    return
  }
  await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(wsl.distro, ['/bin/rm', '-rf', '--', wsl.linuxPath]),
    timeoutMs: 120_000
  })
}

export async function materializeRepoManagedCheckout(args: {
  mainPath: string
  destPath: string
  signal?: AbortSignal
  onPhase?: (phase: RepoManagedDerivePhase) => void
  onSeedProgress?: (progress: RepoManagedSeedProgress) => void
  runCommand?: RepoManagedCommandRunner
}): Promise<void> {
  args.onPhase?.('preparing')
  const wsl = parseWslPath(args.mainPath)
  if (wsl && parseWslPath(args.destPath)?.distro !== wsl.distro) {
    throw new Error('Derived repo workspaces must stay on the same WSL distro as the main tree.')
  }
  if (await pathExists(args.destPath)) {
    throw new Error(`Derive destination already exists: ${args.destPath}`)
  }
  const identity = await readIdentityFromCheckout(args.mainPath)
  const runCommand = args.runCommand ?? defaultRepoCommandRunner
  const program = await resolveRepoProgram({
    mainPath: args.mainPath,
    exists: pathExists,
    runCommand: (cmd) =>
      runCommand({
        program: cmd.program,
        args: cmd.args,
        cwd: cmd.cwd ?? args.mainPath,
        signal: args.signal
      })
  })
  if (program === 'repo') {
    const probe = await runCommand({
      program,
      args: ['--version'],
      cwd: args.mainPath,
      signal: args.signal
    })
    if (probe.code !== 0) {
      throw new Error(REPO_TOOL_MISSING)
    }
  }
  await mkdir(args.destPath, { recursive: true })
  let materialized = false
  try {
    args.onPhase?.('init')
    const initResult = await runCommand({
      program,
      args: normalizeRepoInitArgsForWsl(
        buildRepoInitArgs({ identity, referencePath: args.mainPath }),
        wsl
      ),
      cwd: args.destPath,
      signal: args.signal
    })
    if (initResult.code !== 0) {
      throw new Error(formatRepoCommandFailure('init', initResult.stderr, initResult.stdout))
    }
    args.onPhase?.('seed')
    await seedDerivedRepoProjectGitDirs({
      mainPath: args.mainPath,
      destPath: args.destPath,
      onProgress: args.onSeedProgress
    })
    args.onPhase?.('sync')
    const syncResult = await runCommand({
      program,
      args: buildRepoSyncArgs(),
      cwd: args.destPath,
      signal: args.signal
    })
    if (syncResult.code !== 0) {
      throw new Error(formatRepoCommandFailure('sync', syncResult.stderr, syncResult.stdout))
    }
    materialized = true
  } finally {
    if (!materialized) {
      await removeDerivedPath(args.destPath).catch(() => {})
    }
  }
}

function normalizeRepoInitArgsForWsl(
  args: readonly string[],
  wsl: { distro: string } | null
): string[] {
  if (!wsl) {
    return [...args]
  }
  return args.map((arg) => {
    if (/^\\\\wsl\.localhost\\/i.test(arg) || /^\\\\wsl\$\\/i.test(arg)) {
      const parsed = parseWslPath(arg)
      return parsed?.distro === wsl.distro ? parsed.linuxPath : arg
    }
    return arg
  })
}

export async function deriveRepoManagedFolderWorkspace(args: {
  store: RepoManagedDeriveStore
  projectGroupId: string
  name?: string
  connectionId?: string | null
  linkedTask?: FolderWorkspace['linkedTask']
  linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
  createdWithAgent?: FolderWorkspace['createdWithAgent']
  pendingFirstAgentMessageRename?: boolean
  signal?: AbortSignal
  onPhase?: (phase: RepoManagedDerivePhase) => void
  onSeedProgress?: (progress: RepoManagedSeedProgress) => void
  runCommand?: RepoManagedCommandRunner
}): Promise<FolderWorkspace> {
  const group = args.store.getProjectGroups().find((entry) => entry.id === args.projectGroupId)
  if (!group?.parentPath || !isRepoManagedProjectGroup(group)) {
    throw new Error(REPO_MANAGED_GROUP_REQUIRED)
  }
  if (args.connectionId ?? group.connectionId) {
    throw new Error(REPO_MANAGED_DERIVE_SSH_UNSUPPORTED)
  }
  const workspaceName = args.name?.trim() || `${group.name} workspace`
  const sanitizedName = sanitizeWorktreeName(workspaceName)
  const settings = args.store.getSettings()
  const destPath = await computeWorktreePathAsync(sanitizedName, group.parentPath, {
    nestWorkspaces: settings.nestWorkspaces,
    workspaceDir: settings.workspaceDir || join(homedir(), 'orca', 'workspaces')
  })
  await materializeRepoManagedCheckout({
    mainPath: group.parentPath,
    destPath,
    signal: args.signal,
    onPhase: args.onPhase,
    onSeedProgress: args.onSeedProgress,
    runCommand: args.runCommand
  })
  args.onPhase?.('register')
  try {
    await stat(destPath)
  } catch {
    throw new Error(`Derived repo workspace was not created: ${destPath}`)
  }
  return args.store.createFolderWorkspace({
    projectGroupId: group.id,
    name: workspaceName,
    folderPath: destPath,
    connectionId: null,
    linkedTask: args.linkedTask,
    linkedTaskSourceContext: args.linkedTaskSourceContext,
    createdWithAgent: args.createdWithAgent,
    pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename,
    creatorProvenance: { kind: 'host' }
  })
}
