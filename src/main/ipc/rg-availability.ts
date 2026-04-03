import { spawn } from 'child_process'

// Why: when rg is not installed, spawn('rg', ...) emits both 'error' and
// 'close' events but their ordering is non-deterministic across Node versions
// and platforms. If 'close' fires first the handler resolves with empty
// results before the 'error' handler can trigger the git-grep fallback.
// Checking rg availability once upfront (cached) avoids the race entirely.
let rgAvailableCache: boolean | null = null

export function checkRgAvailable(): Promise<boolean> {
  if (rgAvailableCache !== null) {
    return Promise.resolve(rgAvailableCache)
  }
  return new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' })
    child.once('error', () => {
      rgAvailableCache = false
      resolve(false)
    })
    child.once('close', (code) => {
      if (rgAvailableCache !== null) {
        // error handler already resolved
        return
      }
      rgAvailableCache = code === 0
      resolve(rgAvailableCache)
    })
  })
}
