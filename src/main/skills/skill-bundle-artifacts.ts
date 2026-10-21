import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { SkillBundleManifest } from '../../shared/skill-freshness'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    skills: z.array(
      z
        .object({
          name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
          sourcePath: z.string().min(1),
          packageDigest: sha256Schema,
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
        })
        .strict()
    )
  })
  .strict()

const manifestsByResourceRoot = new Map<string, Promise<SkillBundleManifest>>()

// Why: the manifest ships with the binary and never changes within a run, while
// focus-triggered rescans would otherwise re-read and re-parse it every time.
export function loadSkillBundleManifest(
  resourceRoot = app.isPackaged ? process.resourcesPath : resolve(process.cwd(), 'resources')
): Promise<SkillBundleManifest> {
  const cached = manifestsByResourceRoot.get(resourceRoot)
  if (cached) {
    return cached
  }
  const loading = readSkillBundleManifest(resourceRoot)
  manifestsByResourceRoot.set(resourceRoot, loading)
  loading.catch(() => {
    manifestsByResourceRoot.delete(resourceRoot)
  })
  return loading
}

async function readSkillBundleManifest(resourceRoot: string): Promise<SkillBundleManifest> {
  const value: unknown = JSON.parse(
    await readFile(join(resourceRoot, 'skills', 'current-manifest.json'), 'utf8')
  )
  const result = manifestSchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      `Invalid skill bundle manifest: ${result.error.issues[0]?.message ?? 'schema mismatch'}`
    )
  }
  return result.data
}
