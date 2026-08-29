export const TARGETLESS_BROWSER_METHODS: Record<string, true> = {
  browserProfileClearDefaultCookies: true,
  browserProfileCreate: true,
  browserProfileDelete: true,
  browserProfileDetectBrowsers: true,
  browserProfileImportFromBrowser: true,
  browserProfileList: true,
  browserTabCreate: true,
  browserTabList: true
}

export function electronSidecarRuntimeMethodName(browserMethod: string): string {
  const suffix = browserMethod.slice('browser'.length)
  if (suffix === 'ProceedCertificate') {
    return 'browser.certificate.proceed'
  }
  if (suffix === 'SetViewport') {
    return 'browser.viewport'
  }
  if (suffix === 'SetGeolocation') {
    return 'browser.geolocation'
  }
  for (const group of ['Cookie', 'Intercept', 'Capture'] as const) {
    if (suffix.startsWith(group)) {
      const action = suffix.slice(group.length)
      return `browser.${group.toLowerCase()}.${action[0].toLowerCase()}${action.slice(1)}`
    }
  }
  for (const storage of ['StorageLocal', 'StorageSession'] as const) {
    if (suffix.startsWith(storage)) {
      const action = suffix.slice(storage.length)
      const area = storage === 'StorageLocal' ? 'local' : 'session'
      return `browser.storage.${area}.${action[0].toLowerCase()}${action.slice(1)}`
    }
  }
  return `browser.${suffix[0].toLowerCase()}${suffix.slice(1)}`
}
