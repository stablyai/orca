import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
// A shared bot's transport manifest: package identity and every file with its role and hashes. These
// are the rules the Orca Cloud connector service checks bot envelopes by, kept the same here.
import { createHash } from 'node:crypto'
import * as z from 'zod'
import { MAX_BOT_AVATAR_BYTES } from '../../../shared/bot-avatar'
import { hasUnsafeText, withoutUnsafeText } from '../../../shared/bots/bot-text-scan'
import {
  BOT_PACKAGE_MAX_MANIFEST_BYTES,
  botPackagePartOf,
  botPackageRole
} from '../../../shared/bots/bot-package'
import {
  SkillPackageFileSchema,
  validateSkillPackageName,
  validateSkillPackagePath
} from '../../../shared/skills/packages/skill-package-manifest'

export const BOT_TRANSPORT_MANIFEST_PATH = 'dev.orca.bot-sharing/manifest.json'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const BotTransportFileSchema = lazyZodSchema(() =>
  SkillPackageFileSchema.extend({
    role: z.string().regex(/^(?:manifest|soul|avatar|memory|skill:[a-z0-9-]{1,64})$/)
  }).strict()
)

// The bot's name and purpose appear on the public landing page: short, one line, nothing unsafe.
export const BOT_DISPLAY_NAME_MAX = 80
export const BOT_DESCRIPTION_MAX = 200

/** Text as one landing line: unsafe characters become spaces, whitespace collapses, cut to `maximum`. */
export function landingLine(text: string, maximum: number): string {
  return withoutUnsafeText(text).replace(/\s+/g, ' ').trim().slice(0, maximum).trim()
}

export function isLandingText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length <= maximum && !hasUnsafeText(value)
}

const BotTransportManifestV1Schema = lazyZodSchema(() =>
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('bot'),
      packageId: z.string().regex(ID_PATTERN),
      versionId: z.string().regex(ID_PATTERN),
      /** The cloud package name, `bot-<id>`: what *Update link* finds the package by. */
      name: z.string().refine((name) => {
        try {
          validateSkillPackageName(name)
          return true
        } catch {
          return false
        }
      }),
      /** The bot's own name; bot.json's `name`. */
      displayName: z
        .string()
        .min(1)
        .refine((value) => isLandingText(value, BOT_DISPLAY_NAME_MAX)),
      /** The bot's one-line purpose. */
      description: z.string().refine((value) => isLandingText(value, BOT_DESCRIPTION_MAX)),
      createdAt: z.iso.datetime({ offset: true }),
      files: z.array(BotTransportFileSchema).min(2).max(512),
      botDigest: z.string().regex(SHA256_PATTERN)
    })
    .strict()
)

export type BotTransportManifest = z.infer<typeof BotTransportManifestV1Schema>
export type BotTransportFile = z.infer<typeof BotTransportFileSchema>

const MAX_TOTAL_BYTES = 32 * 1024 * 1024

/** The digest the cloud checks: every file's path, role, kind and content identity, in order. */
export function botPackageDigest(files: readonly BotTransportFile[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          role: file.role,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256
        }))
      )
    )
    .digest('hex')
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Every rule the inventory must meet, on either side of the wire. */
export function parseBotTransportManifest(value: unknown): BotTransportManifest {
  const parsed = BotTransportManifestV1Schema.safeParse(value)
  if (!parsed.success) {
    throw new Error('bot-package-transport-invalid')
  }
  const manifest = parsed.data
  const folded = new Set<string>()
  let previous: string | null = null
  let totalBytes = 0
  for (const file of manifest.files) {
    validateSkillPackagePath(file.path)
    if (previous !== null && compareCodeUnits(file.path, previous) <= 0) {
      throw new Error('bot-package-transport-order')
    }
    previous = file.path
    const key = file.path.toLocaleLowerCase('en-US')
    if (folded.has(key)) {
      throw new Error('bot-package-case-collision')
    }
    folded.add(key)
    const part = botPackagePartOf(file.path)
    if (!part) {
      throw new Error('bot-package-path-not-allowed')
    }
    if (botPackageRole(part) !== file.role) {
      throw new Error('bot-package-role-mismatch')
    }
    // Only a skill's own files may be runnable; every other part is text but the avatar.
    if (
      part.role !== 'skill' &&
      (file.executable || (file.classification === 'binary') !== (part.role === 'avatar'))
    ) {
      throw new Error('bot-package-part-kind')
    }
    if (
      (part.role === 'manifest' && file.size > BOT_PACKAGE_MAX_MANIFEST_BYTES) ||
      (part.role === 'avatar' && file.size > MAX_BOT_AVATAR_BYTES)
    ) {
      throw new Error('bot-package-part-size')
    }
    totalBytes += file.size
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('bot-package-size-limit')
  }
  for (const role of ['manifest', 'soul']) {
    if (!manifest.files.some((file) => file.role === role)) {
      throw new Error(`bot-package-${role}-required`)
    }
  }
  if (botPackageDigest(manifest.files) !== manifest.botDigest) {
    throw new Error('bot-package-digest-mismatch')
  }
  return manifest
}

/**
 * The `name` of a SKILL.md, from its opening frontmatter only: undefined without frontmatter, without
 * a top-level name, or with more than one, so a name in the body never passes. The cloud's rule.
 */
export function skillFrontmatterName(text: string): string | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trimEnd() !== '---') {
    return undefined
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (end === -1) {
    return undefined
  }
  const names = lines
    .slice(1, end)
    .map((line) => /^name\s*:(.*)$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
  if (names.length !== 1) {
    return undefined
  }
  const raw = names[0].trim()
  const quoted = /^(['"])(.*)\1\s*(?:#.*)?$/.exec(raw)
  const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim()
  return value || undefined
}
