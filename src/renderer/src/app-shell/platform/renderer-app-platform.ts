// Cache the immutable preload platform on hot render paths; never cache UA fallback while web window.api may still install.
let cachedAppPlatform: NodeJS.Platform | undefined

export function getRendererAppPlatform(): NodeJS.Platform {
  if (cachedAppPlatform) {
    return cachedAppPlatform
  }
  const preloadPlatform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (preloadPlatform) {
    cachedAppPlatform = preloadPlatform
    return preloadPlatform
  }
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent) {
    return 'linux'
  }
  return 'win32'
}

/** Tests swap the window.api platform stub between cases; the real value never changes. */
export function resetRendererAppPlatformCacheForTests(): void {
  cachedAppPlatform = undefined
}
