import { hostname, userInfo } from 'node:os'
import { posix, win32 } from 'node:path'

export type PathApi = typeof posix | typeof win32

export type IncludePathContext = {
  home: string
  pathApi: PathApi
  rootDir: string
  shortHostname: string
  uid?: string
  username: string
}

const TARGET_DEPENDENT_INCLUDE_TOKENS = new Set(['h', 'n', 'p', 'r', 'j', 'k', 'C'])

/** `null` when a referenced variable is unset: the pattern is unresolvable, not empty. */
export function expandEnvironmentVariables(input: string): string | null {
  let missing = false
  const expanded = input.replaceAll(/\$\{([^}]+)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      missing = true
      return ''
    }
    return value
  })

  return missing ? null : expanded
}

/** `null` for a token only a connection target can supply, which Orca cannot expand offline. */
export function expandIncludeTokens(input: string, context: IncludePathContext): string | null {
  let output = ''

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char !== '%') {
      output += char
      continue
    }

    const token = input[i + 1]
    if (!token) {
      output += char
      continue
    }

    if (token === '%') {
      output += '%'
      i += 1
      continue
    }

    if (TARGET_DEPENDENT_INCLUDE_TOKENS.has(token)) {
      return null
    }

    if (token === 'd') {
      output += context.home
      i += 1
      continue
    }

    if (token === 'u') {
      // getCurrentUser() yields '' when the username is unknown; an empty segment is not a resolution.
      if (!context.username) {
        return null
      }
      output += context.username
      i += 1
      continue
    }

    if (token === 'i') {
      if (!context.uid) {
        return null
      }
      output += context.uid
      i += 1
      continue
    }

    if (token === 'l') {
      output += hostname()
      i += 1
      continue
    }

    if (token === 'L') {
      output += context.shortHostname
      i += 1
      continue
    }

    output += `%${token}`
    i += 1
  }

  return output
}

export function resolveIncludePatternPath(input: string, context: IncludePathContext): string {
  const pathApi = context.pathApi
  if (input === '~') {
    return context.home
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return pathApi.join(context.home, input.slice(2))
  }

  if (pathApi.isAbsolute(input)) {
    return pathApi.normalize(input)
  }

  return pathApi.normalize(pathApi.join(context.rootDir, input))
}

export function getCurrentUid(): string | undefined {
  try {
    const info = userInfo()
    if (typeof info.uid === 'number' && info.uid >= 0) {
      return String(info.uid)
    }
  } catch {
    return undefined
  }

  if (typeof process.getuid === 'function') {
    try {
      return String(process.getuid())
    } catch {
      return undefined
    }
  }

  return undefined
}

export function getCurrentUser(): string {
  try {
    const info = userInfo()
    if (info.username) {
      return info.username
    }
  } catch {
    // Fall back to environment variables below.
  }

  return process.env.USER ?? process.env.USERNAME ?? ''
}

export function getPathApi(filePath: string): PathApi {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') ? win32 : posix
}
