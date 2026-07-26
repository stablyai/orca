import { visit, type JSONPath } from 'jsonc-parser'

export const COOKIE_JSON_FILE_MAX_BYTES = 64 * 1024 * 1024
export const COOKIE_JSON_FILE_MAX_ENTRIES = 250_000
export const COOKIE_JSON_FILE_MAX_DEPTH = 128
export const COOKIE_JSON_FILE_MAX_RETAINED_BYTES = 64 * 1024 * 1024

export type CookieJsonFileLimitKind = 'depth' | 'entries' | 'retained-bytes'
export type CookieJsonFileFormatKind = 'syntax' | 'root'

export class CookieJsonFileLimitError extends Error {
  constructor(
    readonly kind: CookieJsonFileLimitKind,
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Cookie JSON file exceeds the ${kind} limit`)
    this.name = 'CookieJsonFileLimitError'
  }
}

export class CookieJsonFileFormatError extends Error {
  constructor(readonly kind: CookieJsonFileFormatKind) {
    super(`Cookie JSON file has invalid ${kind}`)
    this.name = 'CookieJsonFileFormatError'
  }
}

type Container = {
  kind: 'array' | 'object'
  topLevelEntry: boolean
}

const COOKIE_PROPERTY_NAMES = new Set([
  'domain',
  'name',
  'value',
  'path',
  'secure',
  'httpOnly',
  'sameSite',
  'expirationDate'
])

export function visitCookieJsonFileObjects(
  rawContent: string,
  onObject: (entry: Record<string, unknown>) => void,
  maxEntries = COOKIE_JSON_FILE_MAX_ENTRIES,
  maxDepth = COOKIE_JSON_FILE_MAX_DEPTH
): number {
  enforceJsonNestingDepth(rawContent, maxDepth)
  const containers: Container[] = []
  let rootKind: 'array' | 'other' | null = null
  let currentEntry: Record<string, unknown> | null = null
  let entryCount = 0
  let syntaxError = false

  const countEntry = (): void => {
    entryCount += 1
    if (entryCount > maxEntries) {
      throw new CookieJsonFileLimitError('entries', entryCount, maxEntries)
    }
  }
  const isTopLevelEntry = (path: JSONPath): boolean => rootKind === 'array' && path.length === 1
  const setDirectProperty = (path: JSONPath, value: unknown): void => {
    const property = path[1]
    if (
      currentEntry &&
      path.length === 2 &&
      typeof property === 'string' &&
      COOKIE_PROPERTY_NAMES.has(property)
    ) {
      currentEntry[property] = value
    }
  }

  // Why: retain only fields validation uses instead of materializing the entire external JSON tree.
  visit(
    rawContent,
    {
      onArrayBegin: (_offset, _length, _line, _character, pathSupplier) => {
        const path = pathSupplier()
        if (path.length === 0) {
          rootKind = 'array'
        }
        const topLevelEntry = isTopLevelEntry(path)
        if (topLevelEntry) {
          countEntry()
        } else {
          setDirectProperty(path, undefined)
        }
        containers.push({ kind: 'array', topLevelEntry })
      },
      onArrayEnd: () => {
        containers.pop()
      },
      onObjectBegin: (_offset, _length, _line, _character, pathSupplier) => {
        const path = pathSupplier()
        if (path.length === 0) {
          rootKind = 'other'
        }
        const topLevelEntry = isTopLevelEntry(path)
        if (topLevelEntry) {
          countEntry()
          currentEntry = {}
        } else {
          setDirectProperty(path, undefined)
        }
        containers.push({ kind: 'object', topLevelEntry })
      },
      onObjectEnd: () => {
        const container = containers.pop()
        if (!container || container.kind !== 'object' || !container.topLevelEntry) {
          return
        }
        if (currentEntry) {
          onObject(currentEntry)
        }
        currentEntry = null
      },
      onLiteralValue: (value, _offset, _length, _line, _character, pathSupplier) => {
        const path = pathSupplier()
        if (path.length === 0) {
          rootKind = 'other'
        } else if (isTopLevelEntry(path)) {
          countEntry()
        } else {
          setDirectProperty(path, value)
        }
      },
      onError: () => {
        syntaxError = true
      }
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false }
  )

  if (syntaxError) {
    throw new CookieJsonFileFormatError('syntax')
  }
  if (rootKind !== 'array') {
    throw new CookieJsonFileFormatError('root')
  }
  return entryCount
}

function enforceJsonNestingDepth(rawContent: string, maxDepth: number): void {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < rawContent.length; index += 1) {
    const character = rawContent[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '[' || character === '{') {
      depth += 1
      if (depth > maxDepth) {
        throw new CookieJsonFileLimitError('depth', depth, maxDepth)
      }
    } else if (character === ']' || character === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
}

export function enforceCookieJsonRetainedBytes(observed: number): void {
  if (observed > COOKIE_JSON_FILE_MAX_RETAINED_BYTES) {
    throw new CookieJsonFileLimitError(
      'retained-bytes',
      observed,
      COOKIE_JSON_FILE_MAX_RETAINED_BYTES
    )
  }
}
