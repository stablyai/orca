// Absolute paths an upload command on a paired desktop's page named. While that command runs, the
// desktop may read exactly these files from this host, and nothing else outside the workspace.

const grantsByPage = new Map<string, Map<string, number>>()

export function grantClientPageUploadReads(browserPageId: string, paths: readonly string[]) {
  const grants = grantsByPage.get(browserPageId) ?? new Map<string, number>()
  grantsByPage.set(browserPageId, grants)
  for (const path of paths) {
    grants.set(path, (grants.get(path) ?? 0) + 1)
  }
  return (): void => {
    for (const path of paths) {
      const count = (grants.get(path) ?? 0) - 1
      if (count > 0) {
        grants.set(path, count)
      } else {
        grants.delete(path)
      }
    }
    if (grants.size === 0 && grantsByPage.get(browserPageId) === grants) {
      grantsByPage.delete(browserPageId)
    }
  }
}

export function isClientPageUploadReadGranted(browserPageId: string, path: string): boolean {
  return grantsByPage.get(browserPageId)?.has(path) === true
}
