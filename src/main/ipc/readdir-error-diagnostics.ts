import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'

export type ReadDirThrowSite = 'ssh-provider' | 'authorize' | 'readdir'

/**
 * Redacted shape of a directory path for crash diagnostics.
 *
 * Why shape, not the path: "Error invoking remote method 'fs:readDir'" reaches
 * the renderer with no cause. We want to know *what kind* of path failed (WSL
 * UNC, network share, drive letter, SSH) without recording the path itself —
 * even though breadcrumbs are path-redacted downstream, never collecting the
 * raw path is the safer default.
 */
export function describeReadDirPathShape(
  dirPath: string,
  connectionId: string | undefined
): CrashReportBreadcrumbData {
  const isUNC = /^[\\/]{2}/.test(dirPath)
  const lower = dirPath.toLowerCase()
  // \\wsl$\ and \\wsl.localhost\ (either slash direction) are WSL UNC roots.
  const isWsl = isUNC && (lower.includes('wsl$') || lower.includes('wsl.localhost'))
  const driveLetterMatch = /^([a-zA-Z]):[\\/]/.exec(dirPath)
  return {
    hasConnectionId: Boolean(connectionId),
    isUNC,
    isWsl,
    ...(driveLetterMatch ? { driveLetter: driveLetterMatch[1].toUpperCase() } : {})
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
  }
  return undefined
}

/**
 * Build the redacted breadcrumb payload for a thrown fs:readDir call: which
 * throw site fired, the error code/name, and the path shape — no raw path.
 */
export function buildReadDirErrorBreadcrumb(args: {
  dirPath: string
  connectionId: string | undefined
  throwSite: ReadDirThrowSite
  error: unknown
}): CrashReportBreadcrumbData {
  return {
    throwSite: args.throwSite,
    errorName: args.error instanceof Error ? args.error.name : typeof args.error,
    ...(errorCode(args.error) ? { errorCode: errorCode(args.error)! } : {}),
    ...describeReadDirPathShape(args.dirPath, args.connectionId)
  }
}
