export type HostPathFlavor = 'win32' | 'posix'

// Why: identifies Windows drive-letter paths (e.g. C:, C:\, D:/code) without node:path.
export function isDrivePath(path: string): boolean {
  return /^[a-zA-Z]:(?:[/\\]|$)/.test(path)
}

// Why: drive roots (e.g. C:, C:\, C:/) identify when browsing is at the top of a Windows drive.
export function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[/\\]?$/.test(path)
}

// Why: extracts the drive root with trailing backslash (e.g. D:\) for Windows path navigation.
export function driveRootOf(path: string): string | null {
  if (!isDrivePath(path)) {
    return null
  }
  return `${path.slice(0, 2).toUpperCase()}\\`
}

// Why: empty string or '/' indicates browsing at the root level across both platforms.
export function isAtHostBrowseRoot(resolvedPath: string): boolean {
  return resolvedPath === '/' || resolvedPath === ''
}

// Why: joins paths respecting Windows drive semantics and POSIX root slashes without node:path.
export function joinHostBrowsePath(
  resolvedPath: string,
  name: string,
  pathFlavor: HostPathFlavor
): string {
  if (isAtHostBrowseRoot(resolvedPath)) {
    if (pathFlavor === 'win32' && isDrivePath(name)) {
      return name
    }
    if (pathFlavor === 'posix') {
      return name.startsWith('/') ? name : `/${name}`
    }
    return name.startsWith('\\') || name.startsWith('/') ? name : `\\${name}`
  }

  if (pathFlavor === 'win32') {
    const base =
      resolvedPath.endsWith('\\') || resolvedPath.endsWith('/') ? resolvedPath : `${resolvedPath}\\`
    return `${base}${name}`
  }

  const base = resolvedPath.endsWith('/') ? resolvedPath : `${resolvedPath}/`
  return `${base}${name}`
}

// Why: resolves parent directory, mapping Windows drive root back to '/' for drive list enumeration.
export function parentHostBrowsePath(resolvedPath: string, pathFlavor: HostPathFlavor): string {
  if (isAtHostBrowseRoot(resolvedPath)) {
    return '/'
  }

  if (pathFlavor === 'win32') {
    if (isDriveRoot(resolvedPath)) {
      return '/'
    }
    const trimmed = resolvedPath.replace(/[/\\]+$/, '')
    const lastSlash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
    if (lastSlash === -1) {
      return '/'
    }
    if (lastSlash <= 2 && isDrivePath(trimmed)) {
      return `${trimmed.slice(0, 2)}\\`
    }
    return trimmed.slice(0, lastSlash)
  }

  const trimmed = resolvedPath.replace(/\/+$/, '')
  if (trimmed === '') {
    return '/'
  }
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash <= 0) {
    return '/'
  }
  return trimmed.slice(0, lastSlash)
}
