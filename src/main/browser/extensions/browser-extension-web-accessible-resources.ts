type Manifest = Record<string, unknown>

/**
 * Turns off `use_dynamic_url` on web-accessible resources. Electron hands content scripts the
 * per-session dynamic URL but cannot load it, so frames such as Bitwarden's inline menu never
 * appear. Cost: pages can again probe these files at the extension's fixed URL.
 */
export function withStaticWebAccessibleResources(manifest: Manifest): Manifest {
  const entries = manifest.web_accessible_resources
  if (!Array.isArray(entries)) {
    return manifest
  }
  return {
    ...manifest,
    web_accessible_resources: entries.map((entry: unknown) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      'use_dynamic_url' in entry
        ? { ...entry, use_dynamic_url: false }
        : entry
    )
  }
}

// Chrome matches web-accessible resource paths with `*` and `?` globs, and `*` crosses folders.
function resourcePatternToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/^\/+/, '')
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    )
    .join('')
  return new RegExp(`^${body}$`)
}

/**
 * Keeps Orca's private files out of reach of web pages. A wildcard such as "*" would otherwise
 * expose the worker token, letting any site call Orca's extension API as this extension. Each
 * pattern that matches a private file becomes the explicit list of the package files it matched.
 */
export function withPrivateFilesHiddenFromWebAccessibleResources(
  manifest: Manifest,
  packageFiles: readonly string[],
  privateFiles: readonly string[]
): Manifest {
  const entries = manifest.web_accessible_resources
  if (!Array.isArray(entries)) {
    return manifest
  }
  const isPrivate = new Set(privateFiles)
  const publicFiles = packageFiles.filter((file) => !isPrivate.has(file))
  return {
    ...manifest,
    web_accessible_resources: entries.map((entry: unknown) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return entry
      }
      const resources: unknown = 'resources' in entry ? entry.resources : undefined
      if (!Array.isArray(resources)) {
        return entry
      }
      const next = new Set<string>()
      for (const resource of resources) {
        if (typeof resource !== 'string') {
          continue
        }
        const pattern = resourcePatternToRegExp(resource)
        if (privateFiles.some((file) => pattern.test(file))) {
          publicFiles.filter((file) => pattern.test(file)).forEach((file) => next.add(file))
        } else {
          next.add(resource)
        }
      }
      return { ...entry, resources: [...next] }
    })
  }
}
