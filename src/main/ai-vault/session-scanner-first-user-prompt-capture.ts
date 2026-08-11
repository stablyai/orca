import { AsyncLocalStorage } from 'node:async_hooks'

// Why: list scans must not carry full first-prompt bodies (up to 500 sessions
// per refresh). On-demand copy re-parses one transcript under `full` mode.
export type FirstUserPromptCaptureMode = 'none' | 'full'

const firstUserPromptCaptureStorage = new AsyncLocalStorage<FirstUserPromptCaptureMode>()

export function getFirstUserPromptCaptureMode(): FirstUserPromptCaptureMode {
  return firstUserPromptCaptureStorage.getStore() ?? 'none'
}

export function withFullFirstUserPromptCapture<T>(fn: () => Promise<T>): Promise<T> {
  return firstUserPromptCaptureStorage.run('full', fn)
}
