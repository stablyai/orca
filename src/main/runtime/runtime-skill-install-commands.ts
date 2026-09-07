import { join } from 'node:path'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import { executeSkillInstallRequest } from '../skills/skill-install-request-service'
import { executeSkillBundleInstallRequest } from '../skills/skill-bundle-install-request-service'
import { SkillUploadSessionService } from '../skills/skill-upload-session-service'
import { SKILL_UPLOAD_STAGING_ROOT_NAME } from '../skills/skill-upload-staging-ownership'
import type { IPtyProvider } from '../providers/types'
import type {
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import { installSkillBundleOnSshHost } from '../skills/skill-bundle-ssh-relay-service'
import { normalizeSshRelaySkillDestination } from '../skills/skill-ssh-relay-destination'
import { installSkillOnSshHost } from '../skills/skill-ssh-relay-service'
import type { SkillInstallRequest, SkillInstallResult } from './runtime-skill-types'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-surface'
import {
  createSkillInstallAuthority,
  folderExecutionHostId,
  resolveSkillProviderRoots,
  resolveSkillSshTarget
} from './runtime-skill-install-authority'

export class RuntimeSkillInstallCommands {
  private skillUploadSessions: SkillUploadSessionService | null = null
  private skillUploadSessionsDisposed = false
  protected readonly operations = new Map<string, AbortController>()
  protected readonly progress = new Map<string, SkillBundleInstallProgress>()

  constructor(protected readonly host: RuntimeSkillCommandHost) {}

  protected userDataPath(): string {
    return this.host.getUserDataPath()
  }
  protected requireUploads(): SkillUploadSessionService {
    if (this.skillUploadSessionsDisposed) {
      throw new Error('skill-upload-service-disposed')
    }
    this.skillUploadSessions ??= new SkillUploadSessionService(
      join(this.userDataPath(), 'skill-installs', SKILL_UPLOAD_STAGING_ROOT_NAME)
    )
    return this.skillUploadSessions
  }
  async disposeSkillUploadSessions(): Promise<void> {
    this.skillUploadSessionsDisposed = true
    const sessions = this.skillUploadSessions
    this.skillUploadSessions = null
    await sessions?.dispose()
  }
  protected requireSsh(connectionId: string): IPtyProvider {
    const provider = this.host.getSshProvider(connectionId)
    if (!provider?.requestHostRpc) {
      throw new Error('skill-install-ssh-relay-unavailable')
    }
    return provider
  }
  protected sshTarget(destination: SkillInstallRequest['destination']) {
    return resolveSkillSshTarget(this.host, destination, (id) => this.requireSsh(id))
  }
  protected roots(destination: Parameters<typeof resolveSkillProviderRoots>[1]) {
    return resolveSkillProviderRoots(this.host, destination)
  }
  protected authority() {
    return createSkillInstallAuthority(this.host)
  }
  protected folderExecutionHostId(folder: Parameters<typeof folderExecutionHostId>[0]) {
    return folderExecutionHostId(folder)
  }
  private async executeInstall(
    request: SkillInstallRequest,
    signal: AbortSignal
  ): Promise<SkillInstallResult> {
    const target = await this.sshTarget(request.destination)
    if (target) {
      return installSkillOnSshHost({
        provider: target.provider,
        userDataPath: this.userDataPath(),
        request: {
          ...request,
          destination: normalizeSshRelaySkillDestination(request.destination)
        },
        workspace: target.workspace,
        requireHttps: this.host.isPackaged(),
        signal
      })
    }
    await this.host.skillTransactionRecovery
    const origins = ['https://storage.googleapis.com']
    if (!this.host.isPackaged() && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
      origins.push(
        ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      )
    }
    return executeSkillInstallRequest(request, {
      authority: this.authority(),
      stateDirectory: this.userDataPath(),
      allowedDownloadOrigins: [...new Set(origins)],
      requireHttps: this.host.isPackaged(),
      resolveStagedUpload: (uploadId, identity) => this.requireUploads().take(uploadId, identity),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) => this.roots(destination),
      signal
    })
  }
  async installSharedSkillRequest(
    request: SkillInstallRequest,
    signal?: AbortSignal
  ): Promise<SkillInstallResult> {
    if (this.operations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
    this.operations.set(request.operationId, controller)
    try {
      return await this.executeInstall(request, controller.signal)
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.operations.get(request.operationId) === controller) {
        this.operations.delete(request.operationId)
      }
    }
  }
  async installSharedSkillBundleRequest(
    request: SkillBundleInstallRequest,
    signal?: AbortSignal,
    onProgress?: (progress: SkillBundleInstallProgress) => void
  ): Promise<SkillBundleInstallResult> {
    if (this.operations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
    this.operations.set(request.operationId, controller)
    const report = (value: SkillBundleInstallProgress) => {
      this.progress.set(request.operationId, value)
      try {
        onProgress?.(value)
      } catch {}
    }
    try {
      const target = await this.sshTarget(request.destination)
      if (target) {
        return await installSkillBundleOnSshHost({
          provider: target.provider,
          userDataPath: this.userDataPath(),
          request: {
            ...request,
            destination: normalizeSshRelaySkillDestination(request.destination)
          },
          workspace: target.workspace,
          requireHttps: this.host.isPackaged(),
          signal: controller.signal,
          onProgress: report
        })
      }
      await this.host.skillTransactionRecovery
      const origins = ['https://storage.googleapis.com']
      if (!this.host.isPackaged() && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
        origins.push(
          ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        )
      }
      return await executeSkillBundleInstallRequest(request, {
        authority: this.authority(),
        stateDirectory: this.userDataPath(),
        allowedDownloadOrigins: [...new Set(origins)],
        requireHttps: this.host.isPackaged(),
        resolveStagedUpload: (uploadId, identity) => this.requireUploads().take(uploadId, identity),
        detectProviders: detectInstalledAgentsWithShellPathHydration,
        resolveProviderRootOverrides: (destination) => this.roots(destination),
        signal: controller.signal,
        onProgress: report
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.operations.get(request.operationId) === controller) {
        this.operations.delete(request.operationId)
      }
      this.progress.delete(request.operationId)
    }
  }
  getSharedSkillInstallProgress(operationId: string) {
    return this.progress.get(operationId) ?? null
  }
  cancelSharedSkillInstall(operationId: string): boolean {
    const operation = this.operations.get(operationId)
    operation?.abort()
    return Boolean(operation)
  }
}
