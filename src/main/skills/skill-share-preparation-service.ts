import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SkillSharePreview,
  SkillShareProgress,
  SkillSharePublishInput,
  SkillSharePublishOperation
} from '../../shared/skill-sharing-contract'
import type { SkillCloudVersion } from '../../shared/skill-cloud-contract'
import { createSkillBundleArchive, type CreatedSkillBundle } from './skill-bundle-creation'
import type { SkillCloudService } from './skill-cloud-service'
import { readSkillInstallReceipt } from './skill-install-provenance'

const PREPARATION_TTL_MS = 30 * 60 * 1000
const MAX_PREPARATIONS = 8

type Preparation = {
  created: CreatedSkillBundle
  expiresAt: number
  controller: AbortController | null
  publishedVersion: SkillCloudVersion | null
}

function shareIdempotencyKey(preparationId: string): string {
  return `${preparationId}_share`
}

function preview(id: string, value: Preparation): SkillSharePreview {
  const manifest = value.created.manifest
  const files = manifest.skills.flatMap((skill) => skill.files)
  return {
    preparationId: id,
    packageId: manifest.packageId,
    versionId: manifest.versionId,
    name: manifest.bundleName,
    description: manifest.description,
    packageDigest: manifest.bundleDigest,
    skillCount: manifest.skills.length,
    skills: manifest.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      digest: skill.digest,
      fileCount: skill.files.length,
      totalBytes: skill.files.reduce((total, file) => total + file.size, 0),
      scriptPaths: skill.files
        .filter((file) => file.path.startsWith('scripts/'))
        .map((file) => file.path),
      executablePaths: skill.files.filter((file) => file.executable).map((file) => file.path)
    })),
    archiveSha256: value.created.archiveSha256,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    compressedBytes: value.created.compressedBytes,
    scriptPaths: files.filter((file) => file.path.startsWith('scripts/')).map((file) => file.path),
    executablePaths: files.filter((file) => file.executable).map((file) => file.path),
    expiresAt: new Date(value.expiresAt).toISOString()
  }
}

export class SkillSharePreparationService {
  private readonly preparations = new Map<string, Preparation>()
  private initialized: Promise<void> | null = null
  private preparingCount = 0

  constructor(
    private readonly root: string,
    private readonly cloud: Pick<SkillCloudService, 'createShare' | 'publishVersion'>,
    private readonly options: {
      initializeRoot?: () => Promise<void>
      installStateDirectory?: string
      platform?: NodeJS.Platform
    } = {}
  ) {}

  async prepare(input: {
    sources?: { id?: string; sourceDirectory: string }[]
    sourceDirectory?: string
    bundleName?: string
    description?: string
    packageId?: string
  }): Promise<SkillSharePreview> {
    await this.initialize()
    await this.prune()
    if (this.preparations.size + this.preparingCount >= MAX_PREPARATIONS) {
      throw new Error('skill-share-preparation-limit')
    }
    this.preparingCount += 1
    const preparationId = randomUUID()
    const directory = join(this.root, preparationId)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const requestedSources =
        input.sources ?? (input.sourceDirectory ? [{ sourceDirectory: input.sourceDirectory }] : [])
      const sources = await Promise.all(
        requestedSources.map(async (source) => {
          if (
            (this.options.platform ?? process.platform) !== 'win32' ||
            !this.options.installStateDirectory
          ) {
            return source
          }
          let receipt = await readSkillInstallReceipt(
            this.options.installStateDirectory,
            source.sourceDirectory
          )
          if (!receipt) {
            const physicalSource = await realpath(source.sourceDirectory).catch(() => null)
            if (physicalSource) {
              receipt = await readSkillInstallReceipt(
                this.options.installStateDirectory,
                physicalSource
              )
            }
          }
          return receipt?.fileModes
            ? {
                ...source,
                executablePaths: new Set(
                  receipt.fileModes.filter((file) => file.executable).map((file) => file.path)
                )
              }
            : source
        })
      )
      const created = await createSkillBundleArchive({
        sources,
        bundleName: input.bundleName ?? 'shared-skill',
        description: input.description,
        archivePath: join(directory, 'package.tar.gz'),
        packageId: input.packageId ?? randomUUID(),
        versionId: randomUUID()
      })
      const value: Preparation = {
        created,
        expiresAt: Date.now() + PREPARATION_TTL_MS,
        controller: null,
        publishedVersion: null
      }
      this.preparations.set(preparationId, value)
      return preview(preparationId, value)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    } finally {
      this.preparingCount -= 1
    }
  }

  async publish(
    input: SkillSharePublishInput,
    onProgress?: (progress: SkillShareProgress) => void
  ): Promise<SkillSharePublishOperation> {
    await this.prune()
    const preparation = this.preparations.get(input.preparationId)
    if (!preparation || preparation.expiresAt <= Date.now()) {
      throw new Error('skill-share-preparation-expired')
    }
    if (preparation.controller) {
      throw new Error('skill-share-publish-in-progress')
    }
    const controller = new AbortController()
    preparation.controller = controller
    try {
      let version = preparation.publishedVersion
      if (!version) {
        const published = await this.cloud.publishVersion({
          archivePath: preparation.created.archivePath,
          archiveSha256: preparation.created.archiveSha256,
          compressedBytes: preparation.created.compressedBytes,
          packageId: preparation.created.manifest.packageId,
          idempotencyKey: input.preparationId,
          releaseNotes: input.releaseNotes,
          signal: controller.signal,
          onProgress: (progress) =>
            onProgress?.({ preparationId: input.preparationId, ...progress })
        })
        if (published.status !== 'ok') {
          return published
        }
        version = published.value
        preparation.publishedVersion = version
      }
      onProgress?.({
        preparationId: input.preparationId,
        phase: 'publishing',
        bytesSent: preparation.created.compressedBytes,
        totalBytes: preparation.created.compressedBytes
      })
      const shared = await this.cloud.createShare(version.packageId, {
        idempotencyKey: shareIdempotencyKey(input.preparationId),
        signal: controller.signal
      })
      if (shared.status !== 'ok') {
        return shared
      }
      await this.release(input.preparationId)
      return {
        status: 'ok',
        value: { version, share: shared.value }
      } satisfies SkillSharePublishOperation
    } finally {
      const current = this.preparations.get(input.preparationId)
      if (current) {
        current.controller = null
      }
    }
  }

  cancel(preparationId: string): void {
    this.preparations.get(preparationId)?.controller?.abort()
  }

  async release(preparationId: string): Promise<void> {
    const preparation = this.preparations.get(preparationId)
    preparation?.controller?.abort()
    this.preparations.delete(preparationId)
    await rm(join(this.root, preparationId), { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    for (const preparation of this.preparations.values()) {
      preparation.controller?.abort()
    }
    this.preparations.clear()
    await rm(this.root, { recursive: true, force: true })
  }

  private async prune(): Promise<void> {
    const expired = [...this.preparations.entries()]
      .filter(([, value]) => value.expiresAt <= Date.now() && !value.controller)
      .map(([id]) => id)
    await Promise.all(expired.map((id) => this.release(id)))
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      const initialization = (async () => {
        if (this.options.initializeRoot) {
          await this.options.initializeRoot()
        } else {
          await rm(this.root, { recursive: true, force: true })
          await mkdir(this.root, { recursive: true, mode: 0o700 })
        }
      })()
      this.initialized = initialization
      void initialization.catch(() => {
        if (this.initialized === initialization) {
          this.initialized = null
        }
      })
    }
    await this.initialized
  }
}
