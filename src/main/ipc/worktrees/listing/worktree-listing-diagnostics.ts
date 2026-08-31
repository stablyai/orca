import { shouldEmitBoundedWarning } from '../../bounded-warning-dedupe'

export const loggedUnavailableSshGitProviders = new Set<string>()
export const loggedWorktreeListFailures = new Set<string>()
export const loggedMalformedWorktreeMetaKeys = new Set<string>()

export function warnOnce(keySet: Set<string>, key: string, message: string, error?: unknown): void {
  if (!shouldEmitBoundedWarning(keySet, key)) {
    return
  }
  if (error) {
    console.warn(message, error)
  } else {
    console.warn(message)
  }
}
