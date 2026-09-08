import type { MobilePrShellOperations } from './mobile-pr-shell-operations'

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Mobile PR shell operations are unavailable'))

export const DEFAULT_MOBILE_PR_SHELL_OPERATIONS: MobilePrShellOperations = {
  selection() {},
  success() {},
  error() {},
  writeClipboard: unavailable,
  openExternal: unavailable
}
