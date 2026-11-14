let identities = new WeakMap<Electron.Session, () => string | null>()

export function rememberBrowserSessionProfileIdentity(
  session: Electron.Session,
  resolve: () => string | null
): void {
  identities.set(session, resolve)
}

export function forgetBrowserSessionProfileIdentities(): void {
  identities = new WeakMap()
}

export function getBrowserSessionProfileIdentity(session: Electron.Session): string | null {
  return identities.get(session)?.() ?? null
}
