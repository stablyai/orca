import { AsyncLocalStorage } from 'node:async_hooks'

// Capture full bodies only on demand; list scans must not retain them for every session.
export type FirstUserPromptCaptureMode = 'none' | 'full'

const firstUserPromptCaptureStorage = new AsyncLocalStorage<FirstUserPromptCaptureMode>()

export function getFirstUserPromptCaptureMode(): FirstUserPromptCaptureMode {
  return firstUserPromptCaptureStorage.getStore() ?? 'none'
}

export function withFullFirstUserPromptCapture<T>(fn: () => Promise<T>): Promise<T> {
  return firstUserPromptCaptureStorage.run('full', fn)
}
