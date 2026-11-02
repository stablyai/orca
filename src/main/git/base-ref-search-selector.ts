export function isQualifiedBaseRef(refName: string): boolean {
  return refName.startsWith('refs/heads/') || refName.startsWith('refs/remotes/')
}

export function resolveBaseRefSearchSelector(fullRef: string, shortRef: string): string {
  const parts = /^refs\/(heads|remotes)\/(.+)$/.exec(fullRef)
  if (!parts) {
    return fullRef
  }
  const namespaceName = `${parts[1]}/${parts[2]}`
  const naturalName = parts[2]
  // Apple Git-154 (2.39.5) can corrupt short refs (#19515); retire recovery when affected builds are unsupported.
  // Preserve current-Git disambiguation when removing that compatibility workaround.
  if (shortRef === namespaceName || ![fullRef, namespaceName, naturalName].includes(shortRef)) {
    return fullRef
  }
  // Slash-named locals can collide with remote-tracking refs even without a configured remote.
  if (parts[1] === 'heads' && naturalName.includes('/')) {
    return fullRef
  }
  // Natural names beginning with refs/ must not impersonate another namespace.
  return shortRef.startsWith('refs/') ? fullRef : shortRef
}
