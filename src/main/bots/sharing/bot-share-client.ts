// The bot half of Orca Cloud's package routes (/v1/bot-packages, /v1/bot-shares), over the skill
// request, auth and direct-upload modules. Bot responses are parsed as bot types, never skill ones.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import type {
  SkillCloudOperation,
  SkillCloudOptions
} from '../../../shared/skills/sharing/skill-cloud-contract'
import { resolveArtifactCloudApiUrl } from '../../artifacts/artifact-cloud-config'
import { runSkillCloudOperation } from '../../skills/cloud/skill-cloud-auth'
import { uploadSkillPackageToSignedPolicy } from '../../skills/cloud/skill-cloud-direct-upload'
import { skillCloudRequest } from '../../skills/cloud/skill-cloud-request'
import {
  SKILL_CLOUD_UNCODED_ERROR,
  SkillCloudRequestError
} from '../../skills/cloud/skill-cloud-request-error'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const Id = z.string().regex(ID_PATTERN)

const BotCloudVersionSchema = z.object({
  packageId: Id,
  versionId: Id,
  /** The package name, `bot-<id>`. */
  name: z.string(),
  description: z.string(),
  /** The transport manifest's botDigest. */
  packageDigest: z.string(),
  archiveSha256: z.string(),
  compressedBytes: z.number(),
  createdAt: z.string(),
  /** The transport manifest; `displayName` is the bot's own name. */
  manifest: z.looseObject({ displayName: z.string() })
})
export type BotCloudVersion = z.infer<typeof BotCloudVersionSchema>

/** A version as a link serves it: who published it (null when the account has no display name) and when. */
const BotSharedVersionSchema = BotCloudVersionSchema.extend({
  publisher: z.object({ displayName: z.string().nullable() }),
  publishedAt: z.string()
})
export type BotSharedVersion = z.infer<typeof BotSharedVersionSchema>

const BotCloudShareSchema = z.object({
  id: Id,
  url: z.string(),
  pinnedVersionId: Id
})
export type BotCloudShare = z.infer<typeof BotCloudShareSchema>

const BotCloudOwnedShareSchema = BotCloudShareSchema.extend({
  packageId: Id,
  name: z.string(),
  createdAt: z.string(),
  canonical: z.boolean(),
  pinnedVersionId: Id.optional()
})
export type BotCloudOwnedShare = z.infer<typeof BotCloudOwnedShareSchema>

/** A link that no longer serves the version asked about: the owner moved it. */
export type BotShareMoved = { moved: true }

/** Runs a signed-in call; tests pass their own token and address. */
export type BotCloudAuth = <T>(
  operation: (token: string, apiUrl: string) => Promise<T>
) => Promise<SkillCloudOperation<T>>

function id(value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new Error('bot-cloud-id-invalid')
  }
  return encodeURIComponent(value)
}

const isStatus = (error: unknown, status: number): boolean =>
  error instanceof SkillCloudRequestError && error.statusCode === status

const SIZE_REFUSALS = new Set([
  'skill_package_compressed_size_limit',
  'skill_package_expanded_size_limit',
  'skill_package_total_size_limit',
  'skill_package_storage_quota_exceeded'
])

/** The refusals the owner can act on, as share codes; anything else stays as the cloud sent it. */
export function botShareCloudRefusal(error: unknown): unknown {
  if (!(error instanceof SkillCloudRequestError)) {
    return error
  }
  // Every bot route names its 404s, so an unnamed one is a cloud without bot routes registered.
  if (
    error.code === 'skill_package_bot_sharing_disabled' ||
    (error.statusCode === 404 && error.code === SKILL_CLOUD_UNCODED_ERROR)
  ) {
    return new Error(BOT_SHARE_ERRORS.unavailable)
  }
  if (error.code === 'skill_package_bot_avatar_invalid') {
    return new Error(BOT_SHARE_ERRORS.avatarRefused)
  }
  return SIZE_REFUSALS.has(error.code) ? new Error(BOT_SHARE_ERRORS.tooLarge) : error
}

export class BotShareClient {
  constructor(
    private readonly options: { auth: BotCloudAuth; apiUrl?: string; fetcher?: typeof fetch }
  ) {}

  /** Signed in through the active Orca profile, as skill sharing is. */
  static forProfile(userDataPath: string, options: SkillCloudOptions = {}): BotShareClient {
    return new BotShareClient({
      apiUrl: options.apiUrl,
      auth: (operation) => runSkillCloudOperation({ userDataPath, options, operation })
    })
  }

  private request<T>(input: Parameters<typeof skillCloudRequest>[0]): Promise<T> {
    return skillCloudRequest<T>({ ...input, fetcher: this.options.fetcher }).catch(
      (error: unknown) => {
        throw botShareCloudRefusal(error)
      }
    )
  }

  /** The owner's bot package with this name; null when there is none. */
  findPackageId(name: string): Promise<SkillCloudOperation<string | null>> {
    return this.options.auth(async (token, apiUrl) => {
      const found = await this.request<{ package: { id: string } }>({
        apiUrl,
        authToken: token,
        path: `/v1/bot-packages/by-name/${encodeURIComponent(name)}`
      }).catch((error: unknown) => {
        if (isStatus(error, 404)) {
          return null
        }
        throw error
      })
      return found ? Id.parse(found.package.id) : null
    })
  }

  /** Uploads and finalizes one archive as a new version; a retry of the same archive gets the
   *  version it already made. */
  publishVersion(input: {
    packageId: string
    archivePath: string
    archiveSha256: string
    compressedBytes: number
    signal?: AbortSignal
  }): Promise<SkillCloudOperation<BotCloudVersion>> {
    return this.options.auth(async (token, apiUrl) => {
      let upload: {
        upload: {
          id: string
          policy: Parameters<typeof uploadSkillPackageToSignedPolicy>[0]['policy']
        }
      }
      try {
        upload = await this.request({
          apiUrl,
          authToken: token,
          path: '/v1/skill-packages/uploads',
          method: 'POST',
          body: {
            expectedArchiveSha256: input.archiveSha256,
            expectedCompressedBytes: input.compressedBytes
          },
          idempotencyKey: createHash('sha256')
            .update(`${input.packageId}\0${input.archiveSha256}`)
            .digest('hex'),
          signal: input.signal
        })
      } catch (error) {
        const existing = await this.request<{ package: { versions: unknown[] } }>({
          apiUrl,
          authToken: token,
          path: `/v1/skill-packages/${id(input.packageId)}`,
          signal: input.signal
        }).catch(() => null)
        const published = (existing?.package.versions ?? [])
          .map((version) => BotCloudVersionSchema.safeParse(version))
          .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
          .find((version) => version.archiveSha256 === input.archiveSha256)
        if (published) {
          return published
        }
        throw error
      }
      await uploadSkillPackageToSignedPolicy({
        policy: upload.upload.policy,
        archivePath: input.archivePath,
        expectedBytes: input.compressedBytes,
        signal: input.signal,
        fetcher: this.options.fetcher
      })
      const finalized = await this.request<{ version: unknown }>({
        apiUrl,
        authToken: token,
        path: `/v1/skill-packages/uploads/${id(upload.upload.id)}/finalize`,
        method: 'POST',
        body: {},
        idempotencyKey: upload.upload.id,
        signal: input.signal
      })
      const version = BotCloudVersionSchema.parse(finalized.version)
      if (version.packageId !== input.packageId || version.archiveSha256 !== input.archiveSha256) {
        throw new Error('bot-cloud-published-version-mismatch')
      }
      return version
    })
  }

  /** The package's one link, created or moved to `pinnedVersionId` under the cloud's package lock. */
  canonicalShare(
    packageId: string,
    pinnedVersionId: string,
    idempotencyKey: string
  ): Promise<SkillCloudOperation<BotCloudShare & { created: boolean }>> {
    return this.options.auth(async (token, apiUrl) => {
      const result = await this.request<{ share: unknown }>({
        apiUrl,
        authToken: token,
        path: `/v1/bot-packages/${id(packageId)}/shares`,
        method: 'POST',
        body: { mode: 'canonical', pinnedVersionId },
        idempotencyKey
      })
      return BotCloudShareSchema.extend({ created: z.boolean() }).parse(result.share)
    })
  }

  /** Moves a link to a newer version, only from the version the owner last saw it on. Null when the
   *  link is stopped or gone; moved when it no longer serves `expectedVersionId`. */
  repointShare(
    shareId: string,
    body: { pinnedVersionId: string; expectedVersionId: string },
    idempotencyKey: string
  ): Promise<SkillCloudOperation<BotCloudShare | BotShareMoved | null>> {
    return this.options.auth(async (token, apiUrl) => {
      try {
        const result = await this.request<{ share: unknown }>({
          apiUrl,
          authToken: token,
          path: `/v1/bot-shares/${id(shareId)}`,
          method: 'PATCH',
          body,
          idempotencyKey
        })
        return BotCloudShareSchema.parse(result.share)
      } catch (error) {
        if (isStatus(error, 404)) {
          return null
        }
        if (isStatus(error, 409)) {
          return { moved: true as const }
        }
        throw error
      }
    })
  }

  /** False when the link was already stopped. */
  revokeShare(shareId: string): Promise<SkillCloudOperation<boolean>> {
    return this.options.auth(async (token, apiUrl) => {
      try {
        await this.request<void>({
          apiUrl,
          authToken: token,
          path: `/v1/bot-shares/${id(shareId)}`,
          method: 'DELETE'
        })
        return true
      } catch (error) {
        if (isStatus(error, 404)) {
          return false
        }
        throw error
      }
    })
  }

  listShares(): Promise<SkillCloudOperation<BotCloudOwnedShare[]>> {
    return this.options.auth(async (token, apiUrl) => {
      const result = await this.request<{ shares: unknown }>({
        apiUrl,
        authToken: token,
        path: '/v1/bot-shares'
      })
      return z.array(BotCloudOwnedShareSchema).parse(result.shares)
    })
  }

  /** What a link serves, signed out; moved when it no longer serves `versionId`, null when stopped. */
  async resolveShare(
    shareId: string,
    versionId?: string
  ): Promise<BotSharedVersion | BotShareMoved | null> {
    const query = versionId ? `?versionId=${id(versionId)}` : ''
    try {
      const result = await this.request<{ share: { version: unknown } }>({
        apiUrl: resolveArtifactCloudApiUrl(this.options.apiUrl),
        path: `/v1/bot-shares/${id(shareId)}${query}`
      })
      return BotSharedVersionSchema.parse(result.share.version)
    } catch (error) {
      if (isStatus(error, 404)) {
        return null
      }
      if (isStatus(error, 409)) {
        return { moved: true }
      }
      throw error
    }
  }

  /** A short-lived download of exactly `versionId`; moved when the link has gone past it. */
  async downloadGrant(
    shareId: string,
    versionId: string
  ): Promise<{ grant: unknown; version: BotSharedVersion } | BotShareMoved | null> {
    try {
      const result = await this.request<{ grant: unknown; version: unknown }>({
        apiUrl: resolveArtifactCloudApiUrl(this.options.apiUrl),
        path: `/v1/bot-shares/${id(shareId)}/download-grants`,
        method: 'POST',
        body: { versionId }
      })
      return { grant: result.grant, version: BotSharedVersionSchema.parse(result.version) }
    } catch (error) {
      if (isStatus(error, 404)) {
        return null
      }
      if (isStatus(error, 409)) {
        return { moved: true }
      }
      throw error
    }
  }
}
