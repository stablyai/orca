import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import { executeSkillInstallRequest } from '../skills/skill-install-request-service'
import { executeSkillBundleInstallRequest } from '../skills/skill-bundle-install-request-service'
import { SkillUploadSessionService } from '../skills/skill-upload-session-service'
import { SKILL_UPLOAD_STAGING_ROOT_NAME } from '../skills/skill-upload-staging-ownership'
import {
  installBundledOrcaSkills,
  type BundledOrcaSkillInstallInput
} from '../skills/bundled-orca-skill-install'
import { planBundledOrcaSkills } from '../skills/bundled-orca-skill-plan'
import type { BundledSkillPlan } from '../../shared/skill-freshness'
import type {
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type { SkillInstallRequest, SkillInstallResult } from './runtime-skill-types'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-surface'
import {
  createSkillInstallAuthority,
  folderExecutionHostId,
  isSkillSshDestination,
  resolveSkillProviderRoots
} from './runtime-skill-install-authority'

export const SKILL_SSH_UNAVAILABLE = 'skill-install-ssh-relay-unavailable'

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
  // Why: this process serves no SSH target; a managed host installs skills as a paired runtime.
  protected async refuseSshDestination(
    destination: SkillInstallRequest['destination']
  ): Promise<void> {
    if (await isSkillSshDestination(this.host, destination)) {
      throw new Error(SKILL_SSH_UNAVAILABLE)
    }
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
    await this.refuseSshDestination(request.destination)
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
      await this.refuseSshDestination(request.destination)
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
  // Why this host's global homes only: they are what the freshness inventory scans.
  async installBundledOrcaSkills(
    names: readonly string[],
    signal?: AbortSignal
  ): Promise<SkillInstallResult[]> {
    await this.host.skillTransactionRecovery
    return installBundledOrcaSkills(names, { ...(await this.bundledGlobalInstallInput()), signal })
  }
  // Why: the app's skill freshness is this plan, so it shows what the install will do.
  async planBundledOrcaSkills(names: readonly string[]): Promise<BundledSkillPlan[]> {
    return planBundledOrcaSkills(names, await this.bundledGlobalInstallInput())
  }
  private async bundledGlobalInstallInput(): Promise<BundledOrcaSkillInstallInput> {
    const homeDirectory = homedir()
    const runtimeId = this.host.getRuntimeId()
    return {
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: this.userDataPath(),
      detectedProviders: await detectInstalledAgentsWithShellPathHydration(),
      providerRootOverrides: await this.roots({ scope: 'global', homeDirectory }),
      hostIdentity: runtimeId,
      destinationIdentity: `global:${runtimeId}`
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
