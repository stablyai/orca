import type {
  AgentSkillShareOperation,
  AgentSkillShareRequest
} from '../../shared/agent-skill-sharing-contract'
import type { DiscoveredSkill } from '../../shared/skills'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  SkillBundleInstallPreview,
  SkillBundleInstallPreviewRequest,
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type {
  SkillUploadBeginRequest,
  SkillUploadChunkRequest
} from '../../shared/skill-upload-session-contract'
import type { IPtyProvider } from '../providers/types'
import type { SkillUploadSessionService } from '../skills/skill-upload-session-service'
import type { RuntimeSkillCommands } from './runtime-skill-command-surface'
import type {
  SkillCloudDownloadGrant,
  SkillCloudOperation,
  SkillCloudOptions,
  SkillCloudPackageDetails,
  SkillCloudPublishRequest,
  SkillCloudPublishResult,
  SkillCloudService,
  SkillCloudVersion,
  ManagedSkillInstall,
  SkillInstallPreview,
  SkillInstallPreviewRequest,
  SkillInstallRequest,
  SkillInstallResult,
  SkillProviderRootOverrides,
  SkillRemoveRequest
} from './runtime-skill-types'
export type RuntimeSkillCommandSurface = {
  setSkillCloudService(service: SkillCloudService): void
  assertAgentSkillSharingAllowed(): void
  publishDiscoveredSkillsFromAgent(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation>
  publishSkillPackage(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudPublishResult>>
  publishSkillPackageVersion(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudVersion>>
  createSkillPackageShare(
    packageId: string,
    request: SkillCloudOptions & { pinnedVersionId?: string; idempotencyKey?: string }
  ): ReturnType<SkillCloudService['createShare']>
  resolveSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): ReturnType<SkillCloudService['resolveShare']>
  createSkillDownloadGrant(
    shareId: string,
    options: SkillCloudOptions & { versionId?: string; installTarget?: 'local' | 'remote' }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>>
  createSkillPackageVersionDownloadGrant(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions & { installTarget?: 'local' | 'remote' }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>>
  getSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<SkillCloudPackageDetails>>
  listOwnedSkillShares(options: SkillCloudOptions): ReturnType<SkillCloudService['listOwnedShares']>
  revokeSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): ReturnType<SkillCloudService['revokeShare']>
  deleteSkillPackageVersion(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions
  ): ReturnType<SkillCloudService['deleteVersion']>
  deleteSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): ReturnType<SkillCloudService['deletePackage']>
  installSharedSkillRequest(
    request: SkillInstallRequest,
    signal?: AbortSignal
  ): Promise<SkillInstallResult>
  installSharedSkillBundleRequest(
    request: SkillBundleInstallRequest,
    signal?: AbortSignal,
    onProgress?: (progress: SkillBundleInstallProgress) => void
  ): Promise<SkillBundleInstallResult>
  getSharedSkillInstallProgress(operationId: string): SkillBundleInstallProgress | null
  cancelSharedSkillInstall(operationId: string): boolean
  previewSharedSkillInstallRequest(
    request: SkillInstallPreviewRequest
  ): Promise<SkillInstallPreview>
  previewSharedSkillBundleInstallRequest(
    request: SkillBundleInstallPreviewRequest
  ): Promise<SkillBundleInstallPreview>
  removeSharedSkillInstallRequest(request: SkillRemoveRequest): Promise<SkillInstallResult>
  listManagedSkillInstalls(connectionId?: string): Promise<ManagedSkillInstall[]>
  skillInstallDestinationUsesSsh(destination: SkillInstallRequest['destination']): Promise<boolean>
  resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }): Promise<SkillProviderRootOverrides>
  beginSkillUpload(request: SkillUploadBeginRequest): ReturnType<SkillUploadSessionService['begin']>
  appendSkillUploadChunk(
    request: SkillUploadChunkRequest
  ): ReturnType<SkillUploadSessionService['append']>
  commitSkillUpload(uploadId: string): ReturnType<SkillUploadSessionService['commit']>
  cancelSkillUpload(uploadId: string): ReturnType<SkillUploadSessionService['cancel']>
  disposeSkillUploadSessions(): Promise<void>
}

export function installRuntimeSkillCommandSurface(
  target: RuntimeSkillCommandSurface,
  commands: RuntimeSkillCommands
): void {
  const targetMethods = target as unknown as Record<string, (...args: never[]) => unknown>
  const ownerMethods = commands as unknown as Record<string, (...args: never[]) => unknown>
  let prototype: object | null = Object.getPrototypeOf(commands)
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') {
        targetMethods[name] = ownerMethods[name]!.bind(commands)
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }
}

export type RuntimeSkillCommandHost = {
  getRuntimeId(): string
  getUserDataPath(): string
  isPackaged(): boolean
  getSettings(): { agentSkillSharingEnabled?: boolean }
  listRepos(): {
    id: string
    path: string
    connectionId?: string | null
    executionHostId?: ExecutionHostId | null
  }[]
  listFolderWorkspaces(): {
    id: string
    folderPath: string
    connectionId?: string | null
    executionHostId?: ExecutionHostId | null
  }[]
  listResolvedWorktrees(): Promise<{ id: string; path: string; hostId?: ExecutionHostId }[]>
  showManagedWorktree(selector: string): Promise<{ id: string; path: string }>
  resolveProjectRuntimeForWorktree?(
    worktreeId: string
  ): { status: string; runtime?: { kind: string; distro?: string } } | undefined
  getSshProvider(connectionId: string): IPtyProvider | undefined
  getClaudeConfigDirectory?(
    target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
  ): string | null
  skillTransactionRecovery: Promise<unknown>
}
