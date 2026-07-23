import { app } from 'electron'
import { join, resolve } from 'node:path'
import { z, type ZodType } from 'zod'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import type {
  SkillBundleManifest,
  SkillKnownSnapshot,
  SkillReleaseMapping,
  SkillSnapshotRegistry
} from '../../shared/skill-freshness'

export const SKILL_BUNDLE_CURRENT_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
export const SKILL_BUNDLE_SNAPSHOT_REGISTRY_MAX_BYTES = 16 * 1024 * 1024
export const SKILL_BUNDLE_RELEASE_MAPPING_MAX_BYTES = 2 * 1024 * 1024
export const SKILL_BUNDLE_JSON_MAX_STRUCTURAL_TOKENS = 1_000_000
export const SKILL_BUNDLE_JSON_MAX_NESTING_DEPTH = 128

export type SkillBundleArtifacts = {
  manifest: SkillBundleManifest
  registry: SkillSnapshotRegistry
  releaseMapping: SkillReleaseMapping
  knownSnapshots: Record<string, SkillKnownSnapshot[]>
  releasedAppVersions: Record<string, Record<number, string>>
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const snapshotShape = {
  releaseRevision: z.number().int().positive(),
  packageDigest: sha256Schema,
  gitTreeSha: z.string().regex(/^[a-f0-9]{40}$/),
  files: z
    .array(
      z
        .object({
          path: z.string().min(1),
          size: z.number().int().nonnegative(),
          executable: z.boolean(),
          classification: z.enum(['text', 'binary']),
          exactSha256: sha256Schema,
          textNormalizedSha256: sha256Schema.nullable(),
          identitySha256: sha256Schema
        })
        .strict()
    )
    .min(1)
}
const knownSnapshotSchema = z.object(snapshotShape).strict()
const manifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    skills: z.array(
      z
        .object({
          name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
          sourcePath: z.string().min(1),
          ...snapshotShape
        })
        .strict()
    )
  })
  .strict()
const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.record(z.string().min(1), z.array(knownSnapshotSchema).min(1))
  })
  .strict()
const releaseMappingSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(
      z
        .object({
          appVersion: z.string().min(1),
          skills: z.record(z.string().min(1), z.number().int().positive())
        })
        .strict()
    )
  })
  .strict()

function parseArtifact<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`Invalid ${label}: ${result.error.issues[0]?.message ?? 'schema mismatch'}`)
  }
  return result.data
}

const artifactsByResourceRoot = new Map<string, Promise<SkillBundleArtifacts>>()

// Why: the artifacts ship with the binary and never change within a run, while
// focus-triggered rescans would otherwise re-read and re-parse them every time.
export function loadSkillBundleArtifacts(
  resourceRoot = app.isPackaged ? process.resourcesPath : resolve(process.cwd(), 'resources')
): Promise<SkillBundleArtifacts> {
  const cached = artifactsByResourceRoot.get(resourceRoot)
  if (cached) {
    return cached
  }
  const loading = readSkillBundleArtifacts(resourceRoot)
  artifactsByResourceRoot.set(resourceRoot, loading)
  loading.catch(() => {
    artifactsByResourceRoot.delete(resourceRoot)
  })
  return loading
}

async function readSkillBundleArtifacts(resourceRoot: string): Promise<SkillBundleArtifacts> {
  const bundleRoot = join(resourceRoot, 'skills')
  const [manifestValue, registryValue, releaseMappingValue] = await Promise.all([
    readSkillBundleArtifactJson(
      join(bundleRoot, 'current-manifest.json'),
      SKILL_BUNDLE_CURRENT_MANIFEST_MAX_BYTES
    ),
    readSkillBundleArtifactJson(
      join(bundleRoot, 'snapshot-registry.json'),
      SKILL_BUNDLE_SNAPSHOT_REGISTRY_MAX_BYTES
    ),
    readSkillBundleArtifactJson(
      join(bundleRoot, 'release-mapping.json'),
      SKILL_BUNDLE_RELEASE_MAPPING_MAX_BYTES
    )
  ])
  const manifest: SkillBundleManifest = parseArtifact(
    manifestSchema,
    manifestValue,
    'skill bundle manifest'
  )
  const registry: SkillSnapshotRegistry = parseArtifact(
    registrySchema,
    registryValue,
    'skill snapshot registry'
  )
  const releaseMapping: SkillReleaseMapping = parseArtifact(
    releaseMappingSchema,
    releaseMappingValue,
    'skill release mapping'
  )
  for (const current of manifest.skills) {
    if (
      !registry.skills[current.name]?.some(
        (snapshot) =>
          snapshot.releaseRevision === current.releaseRevision &&
          snapshot.packageDigest === current.packageDigest
      )
    ) {
      throw new Error(`Inconsistent current skill snapshot: ${current.name}`)
    }
  }

  // Why: historical provenance only — the current revision's label is the
  // running build's version, supplied at the inventory boundary, not stored here.
  const releasedAppVersions: Record<string, Record<number, string>> = {}
  for (const release of releaseMapping.releases) {
    for (const [name, revision] of Object.entries(release.skills)) {
      if (!registry.skills[name]?.some((snapshot) => snapshot.releaseRevision === revision)) {
        throw new Error(`Unknown released skill revision: ${name}@${revision}`)
      }
      releasedAppVersions[name] ??= {}
      releasedAppVersions[name][revision] ??= release.appVersion
    }
  }

  return {
    manifest,
    registry,
    releaseMapping,
    // Why: newer-known classification needs every identity packaged with this
    // build, while release mapping remains the provenance record for shipped revisions.
    knownSnapshots: registry.skills,
    releasedAppVersions
  }
}

export async function readSkillBundleArtifactJson(
  path: string,
  maxBytes: number
): Promise<unknown> {
  const { buffer } = await readNodeFileWithinLimit(path, maxBytes)
  const content = buffer.toString('utf8')
  assertJsonTextStructureWithinLimits(content, {
    structuralTokens: SKILL_BUNDLE_JSON_MAX_STRUCTURAL_TOKENS,
    nestingDepth: SKILL_BUNDLE_JSON_MAX_NESTING_DEPTH
  })
  return JSON.parse(content) as unknown
}
