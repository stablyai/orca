import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { CustomBuildInfo } from '../../src/shared/custom-build'
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const schema = z.object({
  id: z.string().min(1).max(256),
  baseVersion: z.string().min(1).max(128),
  profileMode: z.enum(['isolated-preview', 'interactive-preview', 'shared-profile']),
  source: z
    .object({ repository: z.string().regex(/^[a-z\d-]{1,39}\/orca$/i), commit: sha })
    .optional(),
  changes: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        title: z.string().min(1).max(1024),
        pullRequest: z
          .object({
            number: z.number().int().positive(),
            headSha: sha,
            url: z
              .string()
              .url()
              .refine((value) => /^https:\/\/github\.com\/stablyai\/orca\/pull\/\d+$/.test(value))
          })
          .optional()
      })
    )
    .max(100)
})
export function readCustomBuildInfo(): CustomBuildInfo | null {
  const path = process.env.ORCA_CUSTOM_BUILD_MANIFEST
  if (!path) {
    return null
  }
  const bytes = readFileSync(resolve(path))
  if (bytes.length > 1024 * 1024) {
    throw new Error('Custom build manifest exceeds its size limit.')
  }
  const manifest: unknown = JSON.parse(bytes.toString('utf8'))
  return schema.parse(
    manifest && typeof manifest === 'object' && 'info' in manifest ? manifest.info : manifest
  )
}
