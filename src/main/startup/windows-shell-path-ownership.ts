import { win32 as pathWin32 } from 'node:path'

type PathEnvironment = Record<string, string | undefined>

type AppliedWindowsPath = {
  appliedValue: string
  baselineValue: string
  pathKey: string
}

function firstPathKey(env: PathEnvironment): string | undefined {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path' && env[key] !== undefined)
}

export function windowsPathSegmentKey(segment: string): string {
  const normalized = pathWin32.normalize(segment)
  const root = pathWin32.parse(normalized).root
  const withoutTrailingSlash =
    normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
  return withoutTrailingSlash.toLowerCase()
}

function splitPath(pathValue: string): string[] {
  return pathValue.split(pathWin32.delimiter).filter(Boolean)
}

function externalAdditions(application: AppliedWindowsPath, currentValue: string): string[] {
  if (currentValue === application.appliedValue) {
    return []
  }
  // Why: forced Windows preflight appends newly installed registry paths after hydration.
  const appliedKeys = new Set(splitPath(application.appliedValue).map(windowsPathSegmentKey))
  return splitPath(currentValue).filter(
    (segment) => !appliedKeys.has(windowsPathSegmentKey(segment))
  )
}

export class WindowsShellPathOwnership {
  private application: AppliedWindowsPath | null = null

  reset(): void {
    this.application = null
  }

  restore(env: PathEnvironment): void {
    const application = this.application
    if (!application) {
      return
    }
    const pathKey = firstPathKey(env) ?? application.pathKey
    const currentValue = env[pathKey] ?? ''
    const additions = externalAdditions(application, currentValue)
    env[pathKey] = [application.baselineValue, ...additions]
      .filter(Boolean)
      .join(pathWin32.delimiter)
    this.application = null
  }

  apply(env: PathEnvironment, value: string): void {
    const pathKey = firstPathKey(env) ?? 'Path'
    this.application = {
      appliedValue: value,
      baselineValue: env[pathKey] ?? '',
      pathKey
    }
    env[pathKey] = value
  }
}
