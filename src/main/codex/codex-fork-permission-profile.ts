import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const profileSchema = z.union([
  z.strictObject({ type: z.literal('disabled') }),
  z.strictObject({
    type: z.literal('managed'),
    file_system: z.strictObject({
      type: z.literal('restricted'),
      entries: z.array(
        z.strictObject({
          path: z.union([
            z.strictObject({ type: z.literal('path'), path: z.string() }),
            z.strictObject({
              type: z.literal('special'),
              value: z.strictObject({ kind: z.enum(['root', 'slash_tmp', 'tmpdir']) })
            })
          ]),
          access: z.enum(['read', 'write']),
          missing_path_behavior: z.literal('skip').optional()
        })
      )
    }),
    network: z.enum(['restricted', 'enabled'])
  })
])

/** Recognize only profiles exactly expressible by the native legacy sandbox parameters. */
export async function codexForkSandboxFromProfile(value: unknown, cwd: unknown) {
  const parsed = profileSchema.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const profile = parsed.data
  if (profile.type === 'disabled') {
    return { type: 'danger-full-access' }
  }
  const entries = profile.file_system.entries
  const rootReads = entries.filter(
    (entry) =>
      entry.path.type === 'special' &&
      entry.path.value.kind === 'root' &&
      entry.access === 'read' &&
      !entry.missing_path_behavior
  )
  if (rootReads.length !== 1) {
    return undefined
  }
  if (entries.length === 1) {
    return profile.network === 'restricted' ? { type: 'read-only' } : undefined
  }
  if (typeof cwd !== 'string') {
    return undefined
  }
  const canonicalCwd = await realpath(cwd)
  const roots: string[] = []
  const protectedPaths = new Set<string>()
  const temporary = new Set<string>()
  for (const entry of entries) {
    if (rootReads.includes(entry)) {
      continue
    }
    if (entry.path.type === 'special') {
      if (
        entry.access !== 'write' ||
        entry.missing_path_behavior ||
        entry.path.value.kind === 'root' ||
        temporary.has(entry.path.value.kind)
      ) {
        return undefined
      }
      temporary.add(entry.path.value.kind)
    } else if (entry.access === 'write' && !entry.missing_path_behavior) {
      if (!roots.includes(entry.path.path)) {
        roots.push(entry.path.path)
      }
    } else if (entry.access === 'read' && entry.missing_path_behavior === 'skip') {
      protectedPaths.add(entry.path.path)
    } else {
      return undefined
    }
  }
  if (!roots.includes(canonicalCwd)) {
    return undefined
  }
  const expected = roots.flatMap((root) =>
    ['.git', '.agents', '.codex', '.aws'].map((name) => join(root, name))
  )
  if (
    protectedPaths.size !== expected.length ||
    expected.some((path) => !protectedPaths.has(path))
  ) {
    return undefined
  }
  return {
    type: 'workspace-write',
    writable_roots: roots.filter((root) => root !== canonicalCwd),
    network_access: profile.network === 'enabled',
    exclude_tmpdir_env_var: !temporary.has('tmpdir'),
    exclude_slash_tmp: !temporary.has('slash_tmp')
  }
}
