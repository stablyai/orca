import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveInsideExtensionDirectory } from './browser-extension-manifest'

/** Resolve each spelling once without blocking Electron main on filesystem identity checks. */
export async function browserExtensionPrivateResources(
  directory: string,
  manifest: Record<string, unknown>,
  privateFiles: readonly string[],
  signal: AbortSignal
): Promise<ReadonlySet<string>> {
  const candidates = new Set<string>()
  for (const entry of Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : []) {
    if (
      entry &&
      typeof entry === 'object' &&
      'resources' in entry &&
      Array.isArray(entry.resources)
    ) {
      for (const resource of entry.resources) {
        if (typeof resource === 'string') {
          candidates.add(resource)
        }
      }
    }
  }
  const paths = new Map<string, string | null>(
    [...candidates].map((resource) => [
      resource,
      resolveInsideExtensionDirectory(directory, resource)
    ])
  )
  const privatePaths = privateFiles.map((file) => join(directory, file))
  const pending = [
    ...new Set([...paths.values(), ...privatePaths].filter((path): path is string => path !== null))
  ]
  const identities = new Map<string, string>()
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        signal.throwIfAborted()
        const path = pending[cursor++]
        const info = await stat(path, { bigint: true }).catch(() => null)
        if (info) {
          identities.set(path, `${info.dev}:${info.ino}`)
        }
      }
    })
  )
  signal.throwIfAborted()
  const privateIdentities = new Set(
    privatePaths.map((path) => identities.get(path)).filter((id) => id !== undefined)
  )
  return new Set(
    [...paths].flatMap(([resource, path]) =>
      path && privateIdentities.has(identities.get(path)!) ? [resource] : []
    )
  )
}
