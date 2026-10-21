import type { BrowserWindowConstructorOptions } from 'electron'

export type WindowGlassEnvironment = {
  platform: NodeJS.Platform
  release: string
  requested: boolean
  dark: boolean
  reducedTransparency: boolean
  highContrast: boolean
  softwareRendering: boolean
}

export function resolveWindowGlassPolicy(environment: WindowGlassEnvironment): {
  available: boolean
  options: BrowserWindowConstructorOptions
} {
  const { platform, requested, dark, reducedTransparency, highContrast, softwareRendering } =
    environment
  const windowsBuild = Number(environment.release.split('.')[2])
  const supported = platform === 'darwin' || (platform === 'win32' && windowsBuild >= 22621)
  const available =
    requested && supported && !reducedTransparency && !highContrast && !softwareRendering
  if (!available) {
    return { available, options: { backgroundColor: dark ? '#0a0a0a' : '#ffffff' } }
  }
  // Electron 43 makes the renderer transparent for vibrancy when backgroundColor is omitted.
  return {
    available,
    options:
      platform === 'darwin'
        ? { vibrancy: 'under-window', visualEffectState: 'followWindow' }
        : { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
  }
}
