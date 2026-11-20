import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCH_KIND_ALL = 7
const KIND_BIT = { 1: 1, 2: 2, 3: 4 }

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

// LSP glob syntax (*, **, ?, {a,b}, [...]), compiled once per registration; unlike shell globs, * matches dot-files.
export function compileLspGlob(glob, flags = '') {
  let source = ''
  let groups = 0
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      const wholeSegment = (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/')
      if (wholeSegment && glob[i + 2] === '/') {
        source += '(?:[^/]*/)*'
        i += 2
      } else {
        source += wholeSegment ? '.*' : '[^/]*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{') {
      groups++
      source += '(?:'
    } else if (char === '}' && groups > 0) {
      groups--
      source += ')'
    } else if (char === ',' && groups > 0) {
      source += '|'
    } else if (char === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2)
      const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
      source += body.startsWith('!') ? `[^/${body.slice(1)}]` : `[${body}]`
      i = end
    } else {
      source += char.replace(/[.+^$()|\\[\]{}]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}${')'.repeat(groups)}$`, flags)
}

function baseToPath(baseUri) {
  const uri = typeof baseUri === 'string' ? baseUri : baseUri?.uri
  try {
    return uri ? resolve(fileURLToPath(uri)) : null
  } catch {
    return null
  }
}

// Watches outside the workspace (package stores, global caches) are accepted and never fire; installs restart the server.
export function parseWatchers(root, watchers = [], platform = process.platform) {
  // Windows paths compare case-insensitively (drive letters arrive as c: or C:).
  const fold = platform === 'win32' ? (path) => path.toLowerCase() : (path) => path
  const flags = platform === 'win32' ? 'i' : ''
  const rootKey = fold(root)
  const parsed = []
  for (const { globPattern, kind = WATCH_KIND_ALL } of watchers) {
    if (typeof globPattern === 'string') {
      parsed.push({ prefix: null, matcher: compileLspGlob(globPattern, flags), kind })
      continue
    }
    const base = baseToPath(globPattern?.baseUri)
    const baseKey = base === null ? null : fold(base)
    if (baseKey !== null && (baseKey === rootKey || baseKey.startsWith(rootKey + sep))) {
      parsed.push({ prefix: baseKey + sep, fold, matcher: compileLspGlob(globPattern.pattern, flags), kind })
    }
  }
  return parsed
}

export function watcherMatches({ prefix, fold, matcher, kind }, path, type) {
  if ((kind & KIND_BIT[type]) === 0) {
    return false
  }
  if (prefix === null) {
    return matcher.test(toPosix(path))
  }
  return fold(path).startsWith(prefix) && matcher.test(toPosix(path.slice(prefix.length)))
}
