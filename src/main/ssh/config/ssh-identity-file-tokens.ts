import { homedir, hostname, userInfo } from 'node:os'

type TokenSource = (resolved: ReadonlyMap<string, string>) => string | undefined

// OpenSSH expands %d/%u from the passwd entry, which can differ from HOME.
function localUserInfo(): { homedir: string; username: string } | undefined {
  try {
    return userInfo()
  } catch {
    return undefined
  }
}

const TOKEN_SOURCES: Record<string, TokenSource> = {
  '%': () => '%',
  d: () => localUserInfo()?.homedir || homedir(),
  u: () => localUserInfo()?.username || process.env.USER || process.env.USERNAME || undefined,
  i: () => {
    const uid = process.getuid?.()
    return uid === undefined ? undefined : String(uid)
  },
  l: () => hostname(),
  L: () => hostname().split('.')[0],
  h: (resolved) => resolved.get('hostname'),
  n: (resolved) => resolved.get('host'),
  p: (resolved) => resolved.get('port'),
  r: (resolved) => resolved.get('user')
}

/** ssh -G prints IdentityFile `%x` and `${NAME}` raw (OpenSSH expands them at connect time), e.g. `%d/key.pem`. */
export function expandIdentityFileTokens(
  value: string,
  resolved: ReadonlyMap<string, string>
): string {
  if (!value.includes('%') && !value.includes('${')) {
    return value
  }
  // One pass, like OpenSSH: a replacement is never scanned for further tokens.
  let expanded = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '$' && value[index + 1] === '{') {
      const end = value.indexOf('}', index + 2)
      const envValue = end === -1 ? undefined : process.env[value.slice(index + 2, end)]
      // OpenSSH refuses the path when NAME is unset; keep it raw so it reads as missing.
      if (envValue === undefined) {
        return value
      }
      expanded += envValue
      index = end
      continue
    }
    if (char !== '%') {
      expanded += char
      continue
    }
    const source = Object.hasOwn(TOKEN_SOURCES, value[index + 1] ?? '')
      ? TOKEN_SOURCES[value[index + 1]]
      : undefined
    const replacement = source?.(resolved)
    // Unknown tokens (%C, %j, %k) need OpenSSH internals; keep the raw path rather than guess.
    if (replacement === undefined) {
      return value
    }
    expanded += replacement
    index += 1
  }
  return expanded
}
