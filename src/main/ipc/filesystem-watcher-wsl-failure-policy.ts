import { WslWatcherCompatibilityError } from './filesystem-watcher-wsl-runtime'

// Why: compatibility failures (unsupported distro, missing/corrupt bundle)
// cannot heal at runtime, so reprobing native watching would spin forever.
export function isPermanentWslNativeFailure(error: unknown): boolean {
  return error instanceof WslWatcherCompatibilityError
}
