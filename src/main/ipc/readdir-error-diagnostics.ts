import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'

export type ReadDirThrowSite = 'ssh-provider' | 'authorize' | 'readdir'

/** Classify failed directory paths without collecting raw paths in crash diagnostics. */
export function classifyReadDirPath(
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

/** Report throw site, error code/name and path shape without raw paths. */
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
    ...classifyReadDirPath(args.dirPath, args.connectionId)
  }
}
