import { lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

export const profileFilesystemIdentitySchema = z.strictObject({
  device: z.string().max(32).regex(/^\d+$/),
  inode: z
    .string()
    .max(32)
    .regex(/^[1-9]\d*$/),
  birth: z.string().max(32).regex(/^\d+$/)
})
const participationSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('process-held-root-lock'),
  processIncarnation: z.uuid(),
  physicalRoot: z
    .string()
    .min(1)
    .max(32768)
    .refine((path) => isAbsolute(path) && !path.includes('\0')),
  root: profileFilesystemIdentitySchema,
  lock: profileFilesystemIdentitySchema
})
export type ProfileLifetimeParticipation = z.infer<typeof participationSchema>

export function parseProfileLifetimeParticipation(value: unknown): ProfileLifetimeParticipation {
  const parsed = participationSchema.parse(value)
  Object.freeze(parsed.root)
  Object.freeze(parsed.lock)
  return Object.freeze(parsed)
}

function identity(path: string, directory: boolean) {
  const stat = lstatSync(path, { bigint: true })
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error('profile_lifetime_participation_identity_unavailable')
  }
  return { device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs) }
}

/** Observation under retained native authority; not an assertion that remote work retired. */
export function captureProfileLifetimeParticipation(
  physicalRoot: string,
  processIncarnation: string,
  assertCurrent: () => void
): ProfileLifetimeParticipation {
  assertCurrent()
  const record = parseProfileLifetimeParticipation({
    version: 1,
    kind: 'process-held-root-lock',
    processIncarnation,
    physicalRoot,
    root: identity(physicalRoot, true),
    lock: identity(join(physicalRoot, 'profile-lifetime.lock'), false)
  })
  assertCurrent()
  return record
}
