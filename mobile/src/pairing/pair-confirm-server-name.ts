// A page that asks a server for this phone's pairing names that server on pair-confirm. A deep link
// could name anything, so only a name the shell takes off a page's navigation reaches the screen,
// kept by the pairing code it came with.
const PAIR_CONFIRM_PATH = '/pair-confirm'
const KEPT_NAMES = 4
const NAME_MAX_CHARS = 80
const namesByCode = new Map<string, string>()

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/** Keeps the `server` a page's pair-confirm navigation names, and returns the href without it. */
export function keepPairConfirmServerName(href: string): string {
  const queryAt = href.indexOf('?')
  if (queryAt === -1 || href.slice(0, queryAt) !== PAIR_CONFIRM_PATH) {
    return href
  }
  const fields = href.slice(queryAt + 1).split('&')
  const valueOf = (name: string): string | null => {
    const field = fields.find((entry) => entry.startsWith(`${name}=`))
    return field === undefined ? null : decoded(field.slice(name.length + 1))
  }
  const server = valueOf('server')?.trim()
  const code = valueOf('code')
  if (server && code) {
    namesByCode.delete(code)
    namesByCode.set(code, server.slice(0, NAME_MAX_CHARS))
    for (const oldest of namesByCode.keys()) {
      if (namesByCode.size <= KEPT_NAMES) {
        break
      }
      namesByCode.delete(oldest)
    }
  }
  const kept = fields.filter((entry) => !entry.startsWith('server='))
  return `${PAIR_CONFIRM_PATH}?${kept.join('&')}`
}

export function pairConfirmServerName(code: string | undefined): string | null {
  return code === undefined ? null : (namesByCode.get(code) ?? null)
}
