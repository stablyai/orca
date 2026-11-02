import { loadMobileTerminalThemeMode } from './terminal-theme-preference'

// A stalled preference read must not hold the native splash indefinitely.
export async function startMobileTerminalAppearance(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      loadMobileTerminalThemeMode(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000)
      })
    ])
  } catch (error) {
    console.warn('Failed to load terminal appearance preference', error)
  } finally {
    clearTimeout(timer)
  }
}
