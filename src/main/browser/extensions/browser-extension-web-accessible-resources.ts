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
 * Keeps Orca's private files out of reach of web pages. Chromium matches the URL's spelling but
 * serves through the file system, where other spellings (case, Unicode folding, 8.3 names) can
 * name a private file. So every pattern becomes the package files it matches, and `isPrivate`
 * drops any entry that is a private file on disk, whatever its spelling.
 */
export function withPrivateFilesHiddenFromWebAccessibleResources(
  manifest: Manifest,
  packageFiles: readonly string[],
  isPrivate: (resource: string) => boolean
): Manifest {
  const entries = manifest.web_accessible_resources
  if (!Array.isArray(entries)) {
    return manifest
  }
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
        const matched = /[*?]/.test(resource)
          ? packageFiles.filter((file) => pattern.test(file))
          : [resource]
        matched.filter((file) => !isPrivate(file)).forEach((file) => next.add(file))
      }
      return { ...entry, resources: [...next] }
    })
  }
}
