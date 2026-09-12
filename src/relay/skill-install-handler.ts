import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../shared/child-process/run-process'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import { splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_BUNDLE_PREVIEW_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from '../shared/skill-install-capability'
import type { ManagedSkillInstall } from '../shared/skill-install-contract'
import type { SkillBundleInstallProgress } from '../shared/skill-bundle-install-contract'
import {
  SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD,
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD,
  SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD,
  SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
  SKILL_SSH_RELAY_INSTALL_METHOD,
  SKILL_SSH_RELAY_GET_INSTALL_PROGRESS_METHOD,
  SKILL_SSH_RELAY_LIST_METHOD,
  SKILL_SSH_RELAY_PREVIEW_METHOD,
  SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
  SKILL_SSH_RELAY_REMOVE_METHOD,
  SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD,
  SkillSshInstallBundleParamsSchema,
  SkillSshInstallProgressParamsSchema,
  SkillSshInstallParamsSchema,
  SkillSshListParamsSchema,
  SkillSshPreviewParamsSchema,
  SkillSshPreviewBundleParamsSchema,
  SkillSshRemoveParamsSchema,
  type SkillSshWorkspaceAuthority
} from '../shared/skill-ssh-relay-contract'
import {
  SkillUploadBeginRequestSchema,
  SkillUploadChunkRequestSchema,
  SkillUploadCommitRequestSchema
} from '../shared/skill-upload-session-contract'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  getTuiAgentDetectionProbeCommands,
  resolveDetectedTuiAgentIds
} from '../shared/tui-agent-detection-commands'
import type { RelayDispatcher } from './dispatcher'
import { isCommandOnPathForRelay } from './preflight-handler'
import type { SkillInstallDestinationAuthority } from '../main/skills/skill-install-destinations'
import {
  previewSharedSkillBundleInstall,
  previewSharedSkillInstall,
  removeSharedSkillInstall
} from '../main/skills/skill-install-management-service'
import { listManagedSkillInstalls } from '../main/skills/skill-install-provenance'
import { executeSkillInstallRequest } from '../main/skills/skill-install-request-service'
import { executeSkillBundleInstallRequest } from '../main/skills/skill-bundle-install-request-service'
import { SkillUploadSessionService } from '../main/skills/skill-upload-session-service'
import { SKILL_UPLOAD_STAGING_ROOT_NAME } from '../main/skills/skill-upload-staging-ownership'
import {
  SkillInstallOperationError,
  skillInstallFailureFromError
} from '../main/skills/skill-install-operation-error'
import { recoverPendingSkillTransactions } from '../main/skills/skill-transaction-startup-recovery'
import { resolveEnvironmentSkillProviderRoots } from '../main/skills/skill-provider-runtime-roots'
import { readRelayWorktreeList } from './git-handler-worktree-list'
import { areRelayWorktreePathsEqual } from './git-handler-worktree-ops'
import { buildRelayGitEnv } from './relay-command-env'

const SSH_SKILL_ENVIRONMENT_ID = 'ssh-host'
const skillRelayGitCapabilities = new GitCapabilityCache()

export const SKILL_RELAY_CAPABILITIES = [
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_BUNDLE_PREVIEW_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY
] as const

export class SkillInstallHandler {
  private readonly homeDirectory: string
  private readonly stateDirectory: string
  private readonly uploads: SkillUploadSessionService
  private readonly detectProviders: () => Promise<readonly string[]>
  private readonly recovery: Promise<unknown>
  private readonly installProgress = new Map<string, SkillBundleInstallProgress>()

  constructor(
    private readonly dispatcher: RelayDispatcher,
    options: {
      homeDirectory?: string
      stateDirectory?: string
      detectProviders?: () => Promise<readonly string[]>
      recovery?: Promise<unknown>
    } = {}
  ) {
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.stateDirectory = options.stateDirectory ?? join(this.homeDirectory, '.orca')
    this.uploads = new SkillUploadSessionService(
      join(this.stateDirectory, 'skill-installs', SKILL_UPLOAD_STAGING_ROOT_NAME)
    )
    this.detectProviders = options.detectProviders ?? detectRelaySkillProviders
    this.recovery = (
      options.recovery ??
      recoverPendingSkillTransactions(join(this.stateDirectory, 'skill-installs'))
    ).catch((error) => {
      console.warn('[skills] relay startup transaction recovery failed:', error)
    })
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest(SKILL_SSH_RELAY_INSTALL_METHOD, async (params, context) => {
      const input = SkillSshInstallParamsSchema.parse(params)
      return this.executeSkillOperation(() =>
        executeSkillInstallRequest(input.request, {
          authority: this.authority(input.workspace),
          stateDirectory: this.stateDirectory,
          allowedDownloadOrigins: ['https://storage.googleapis.com'],
          requireHttps: true,
          resolveStagedUpload: (uploadId, identity) => this.uploads.take(uploadId, identity),
          detectProviders: this.detectProviders,
          resolveProviderRootOverrides: () => resolveEnvironmentSkillProviderRoots(),
          signal: context.signal
        })
      )
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD, async (params, context) => {
      const input = SkillSshInstallBundleParamsSchema.parse(params)
      return this.executeSkillOperation(async () => {
        try {
          return await executeSkillBundleInstallRequest(input.request, {
            authority: this.authority(input.workspace),
            stateDirectory: this.stateDirectory,
            allowedDownloadOrigins: ['https://storage.googleapis.com'],
            requireHttps: true,
            resolveStagedUpload: (uploadId, identity) => this.uploads.take(uploadId, identity),
            detectProviders: this.detectProviders,
            resolveProviderRootOverrides: () => resolveEnvironmentSkillProviderRoots(),
            signal: context.signal,
            onProgress: (progress) => this.installProgress.set(input.request.operationId, progress)
          })
        } finally {
          this.installProgress.delete(input.request.operationId)
        }
      })
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_GET_INSTALL_PROGRESS_METHOD, async (params) => {
      const input = SkillSshInstallProgressParamsSchema.parse(params)
      return this.installProgress.get(input.operationId) ?? null
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_PREVIEW_METHOD, async (params) => {
      const input = SkillSshPreviewParamsSchema.parse(params)
      return this.executeSkillOperation(() =>
        previewSharedSkillInstall(input.request, {
          authority: this.authority(input.workspace),
          stateDirectory: this.stateDirectory,
          detectProviders: this.detectProviders,
          resolveProviderRootOverrides: () => resolveEnvironmentSkillProviderRoots()
        })
      )
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD, async (params) => {
      const input = SkillSshPreviewBundleParamsSchema.parse(params)
      return this.executeSkillOperation(() =>
        previewSharedSkillBundleInstall(input.request, {
          authority: this.authority(input.workspace),
          stateDirectory: this.stateDirectory,
          detectProviders: this.detectProviders,
          resolveProviderRootOverrides: () => resolveEnvironmentSkillProviderRoots()
        })
      )
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_REMOVE_METHOD, async (params) => {
      const input = SkillSshRemoveParamsSchema.parse(params)
      return this.executeSkillOperation(() =>
        removeSharedSkillInstall(input.request, {
          authority: this.authority(input.workspace),
          stateDirectory: this.stateDirectory,
          detectProviders: this.detectProviders,
          resolveProviderRootOverrides: () => resolveEnvironmentSkillProviderRoots()
        })
      )
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_LIST_METHOD, async (params) => {
      const input = SkillSshListParamsSchema.parse(params)
      return this.listManagedInstalls(input.workspaces)
    })
    this.dispatcher.onRequest(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, (params) =>
      this.uploads.begin(SkillUploadBeginRequestSchema.parse(params))
    )
    this.dispatcher.onRequest(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, (params) =>
      this.uploads.append(SkillUploadChunkRequestSchema.parse(params))
    )
    this.dispatcher.onRequest(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, (params) =>
      this.uploads.commit(SkillUploadCommitRequestSchema.parse(params).uploadId)
    )
    this.dispatcher.onRequest(SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD, async (params) => {
      await this.uploads.cancel(SkillUploadCommitRequestSchema.parse(params).uploadId)
      return { ok: true }
    })
  }

  // Worktree ids: host git-worktree list. Folder ids are UUIDs — use the host folder path, not git.
  private authority(workspace?: SkillSshWorkspaceAuthority): SkillInstallDestinationAuthority {
    return {
      environmentId: SSH_SKILL_ENVIRONMENT_ID,
      homeDirectory: this.homeDirectory,
      mustContainInHome: true,
      resolveWorktree: async (id) => {
        if (workspace?.kind !== 'worktree' || workspace.id !== id) {
          return null
        }
        const candidate = splitWorktreeIdForFilesystem(id)?.worktreePath
        const path = candidate ? await listedWorktreePath(candidate) : null
        return path ? { id, path } : null
      },
      resolveFolderWorkspace: async (id) =>
        workspace?.kind === 'folder' && workspace.id === id ? { id, path: workspace.path } : null
    }
  }

  private async executeSkillOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.recovery
      return await operation()
    } catch (error) {
      const failure = skillInstallFailureFromError(error)
      if (!failure) {
        throw error
      }
      throw new SkillInstallOperationError(failure, { cause: error })
    }
  }

  async dispose(): Promise<void> {
    await this.uploads.dispose()
  }

  private async listManagedInstalls(
    workspaces: SkillSshWorkspaceAuthority[]
  ): Promise<ManagedSkillInstall[]> {
    await this.recovery
    const installs = await listManagedSkillInstalls(join(this.stateDirectory, 'skill-installs'))
    return installs.flatMap((install): ManagedSkillInstall[] => {
      if (install.scope === 'global') {
        return [{ ...install, destination: { scope: 'global', executionTarget: { kind: 'host' } } }]
      }
      const prefix = `workspace:${SSH_SKILL_ENVIRONMENT_ID}:`
      const workspace = workspaces.find(
        (candidate) => install.destinationIdentity === `${prefix}${candidate.id}`
      )
      if (!workspace) {
        return []
      }
      return [
        {
          ...install,
          destination:
            workspace.kind === 'worktree'
              ? { scope: 'workspace', worktreeId: workspace.id }
              : { scope: 'workspace', folderWorkspaceId: workspace.id }
        }
      ]
    })
  }
}

async function execRelayGit(args: string[], cwd: string) {
  const result = await runProcess({ program: 'git', args, cwd, env: buildRelayGitEnv() })
  if (result.code === 0) {
    return { stdout: result.stdout, stderr: result.stderr }
  }
  throw Object.assign(new Error(result.stderr.trim() || `git ${args[0] ?? 'command'} failed.`), {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  })
}

async function listedWorktreePath(candidate: string) {
  try {
    const listed = await readRelayWorktreeList(execRelayGit, candidate, skillRelayGitCapabilities)
    const resolvedCandidate = await realpath(candidate)
    for (const worktree of listed) {
      const resolved = await realpath(worktree.path).catch(() => null)
      if (resolved && areRelayWorktreePathsEqual(resolved, resolvedCandidate)) {
        return resolved
      }
    }
  } catch {
    return null
  }
  return null
}

export async function detectRelaySkillProviders(): Promise<string[]> {
  const runtime = process.platform
  const probes = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  const found = await Promise.all(
    probes.map(async (command) => ({ command, found: await isCommandOnPathForRelay(command) }))
  )
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    new Set(found.filter((item) => item.found).map((item) => item.command)),
    runtime
  )
}
