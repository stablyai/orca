export function wslHookRelayStateKey(distro: string, user?: string): string {
  if (user !== undefined && (!user || user.trim() !== user || /[\0\r\n]/.test(user))) {
    throw new Error('Invalid WSL hook relay user')
  }
  const normalized = distro.trim().toLowerCase()
  return user === undefined ? normalized : JSON.stringify([normalized, user])
}
