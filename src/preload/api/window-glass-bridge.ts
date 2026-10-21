import { ipcRenderer } from 'electron'

let available = process.argv.includes('--orca-window-glass=available')
const subscribers = new Set<(available: boolean) => void>()

// Cache updates before React mounts so a theme change during startup cannot leave stale glass.
ipcRenderer.on('window-glass:changed', (_event, value: unknown) => {
  available = value === true
  for (const callback of subscribers) {
    callback(available)
  }
})

export const windowGlassApi = {
  getWindowGlassAvailable: (): boolean => available,
  onWindowGlassChanged: (callback: (available: boolean) => void): (() => void) => {
    subscribers.add(callback)
    callback(available)
    return () => {
      subscribers.delete(callback)
    }
  }
}
