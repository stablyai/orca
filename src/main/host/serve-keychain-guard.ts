import {
  describeKeychainUnavailable,
  probeMacosKeychainReachability
} from './macos-keychain-reachability'
import { withholdSafeStorage } from './safe-storage-availability'

/** Probe headless macOS keychains in a bounded child before secret access; desktop sessions can answer prompts (#25453). */
export async function withholdUnreachableKeychainForServe(
  deps: {
    platform?: NodeJS.Platform
    /** A mock keychain never prompts, so there is nothing to probe. */
    usesMockKeychain?: boolean
    probe?: typeof probeMacosKeychainReachability
    warn?: (message: string) => void
  } = {}
): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'darwin' || deps.usesMockKeychain === true) {
    return
  }
  const reachability = await (deps.probe ?? probeMacosKeychainReachability)()
  if (reachability.kind !== 'unavailable') {
    return
  }
  const reason = describeKeychainUnavailable(reachability.reason)
  withholdSafeStorage(reason)
  ;(deps.warn ?? console.warn)(
    `[secrets] Secrets are unavailable for this run: ${reason}. Orca will not use the keychain until it restarts, so sealed settings such as a saved proxy URL are not applied. Start orca serve from a logged-in desktop session, or unlock the login keychain, to seal credentials.`
  )
}
