/**
 * Read the top-level option keys of a call's object-literal argument out of raw
 * source text.
 *
 * Text rather than an AST because typescript@7 no longer ships the classic
 * compiler API and every installed parser is a transitive dependency. The
 * tradeoff is handled by refusing to guess: any shape this cannot read comes
 * back as `unreadable` with a reason, and callers must treat that as a failure
 * rather than as an absence of keys.
 */

export type CallOptionKeys =
  | { readonly readable: true; readonly keys: readonly string[] }
  | { readonly readable: false; readonly reason: string }

type ScanState = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'

function closesString(state: ScanState, current: string): boolean {
  return (
    (state === 'single' && current === "'") ||
    (state === 'double' && current === '"') ||
    (state === 'template' && current === '`')
  )
}

function opensNonCode(current: string, next: string | undefined): ScanState | null {
  if (current === '/' && next === '/') {
    return 'line'
  }
  if (current === '/' && next === '*') {
    return 'block'
  }
  if (current === "'") {
    return 'single'
  }
  if (current === '"') {
    return 'double'
  }
  if (current === '`') {
    return 'template'
  }
  return null
}

/**
 * Text between an open paren and its match, tracking strings and comments so a
 * brace inside either cannot unbalance the count. Null when it never closes.
 */
function balancedArguments(text: string, openIndex: number): string | null {
  let depth = 0
  let state: ScanState = 'code'
  for (let index = openIndex; index < text.length; index++) {
    const current = text[index]
    const next = text[index + 1]
    if (state === 'code') {
      const opened = opensNonCode(current, next)
      if (opened) {
        state = opened
        if (opened === 'line' || opened === 'block') {
          index++
        }
      } else if (current === '(' || current === '{' || current === '[') {
        depth++
      } else if (current === ')' || current === '}' || current === ']') {
        depth--
        if (depth === 0) {
          return text.slice(openIndex + 1, index)
        }
        if (depth < 0) {
          return null
        }
      }
      continue
    }
    if (state === 'line') {
      if (current === '\n') {
        state = 'code'
      }
      continue
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        state = 'code'
        index++
      }
      continue
    }
    if (current === '\\') {
      index++
      continue
    }
    // Brace tracking inside `${}` would need its own depth; templates never
    // appear as options, so report one as unreadable instead of guessing.
    if (state === 'template' && current === '$' && next === '{') {
      return null
    }
    if (closesString(state, current)) {
      state = 'code'
    }
  }
  return null
}

/** Keys at depth 0 of an object literal body, with anything non-identifier kept verbatim. */
function objectLiteralKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  let state: ScanState = 'code'
  let inValue = false
  let token = ''
  const flush = (): void => {
    const name = token.trim()
    token = ''
    if (name && depth === 0) {
      keys.push(name)
    }
  }
  for (let index = 0; index < body.length; index++) {
    const current = body[index]
    const next = body[index + 1]
    if (state === 'code') {
      const opened = opensNonCode(current, next)
      if (opened) {
        state = opened
        if (opened === 'line' || opened === 'block') {
          index++
        }
      } else if (current === '(' || current === '{' || current === '[') {
        depth++
        if (!inValue) {
          token += current
        }
      } else if (current === ')' || current === '}' || current === ']') {
        depth--
        if (!inValue) {
          token += current
        }
      } else if (current === ':' && depth === 0 && !inValue) {
        flush()
        inValue = true
      } else if (current === ',' && depth === 0) {
        // A shorthand or a spread ends here having never seen a colon.
        if (inValue) {
          inValue = false
          token = ''
        } else {
          flush()
        }
      } else if (!inValue) {
        token += current
      }
      continue
    }
    if (state === 'line') {
      if (current === '\n') {
        state = 'code'
      }
      continue
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        state = 'code'
        index++
      }
      continue
    }
    if (current === '\\') {
      index++
      continue
    }
    if (closesString(state, current)) {
      state = 'code'
    }
  }
  if (!inValue) {
    flush()
  }
  return keys
}

/**
 * Option keys of the call whose argument list opens at `parenIndex`, or the
 * reason the shape could not be read. Spreads and computed keys land in the
 * latter: either can carry a key this would otherwise report as absent.
 */
export function readCallOptionKeys(text: string, parenIndex: number): CallOptionKeys {
  const args = balancedArguments(text, parenIndex)
  if (args === null) {
    return { readable: false, reason: 'argument list never closes' }
  }
  if (!args.trim()) {
    return { readable: false, reason: 'called with no options argument' }
  }
  const trimmed = args.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { readable: false, reason: 'options are not an object literal' }
  }
  const keys = objectLiteralKeys(trimmed.slice(1, -1))
  const unreadable = keys.find((key) => !/^[A-Za-z_$][\w$]*$/.test(key))
  if (unreadable !== undefined) {
    return { readable: false, reason: `unreadable option key \`${unreadable}\`` }
  }
  return { readable: true, keys }
}
