export type DesktopWindowChromeInput = {
  platform: NodeJS.Platform
  isWebClient: boolean
}

export function isPairedWebClientWindow(): boolean {
  type NativeGlobal = typeof globalThis & {
    __ORCA_WEB_CLIENT__?: boolean
    __TAURI_INTERNALS__?: unknown
  }
  const nativeGlobal: NativeGlobal = globalThis
  return nativeGlobal.__ORCA_WEB_CLIENT__ === true && !nativeGlobal.__TAURI_INTERNALS__
}

export function isLocalWindowsDesktopClient(): boolean {
  return (
    !isPairedWebClientWindow() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Windows')
  )
}

export function shouldRenderDesktopWindowChrome({
  platform,
  isWebClient
}: DesktopWindowChromeInput): boolean {
  return !isWebClient && (platform === 'win32' || platform === 'linux')
}
