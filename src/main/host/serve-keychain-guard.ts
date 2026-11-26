import {
  describeKeychainUnavailable,
  probeMacosKeychainReachability
} from './macos-keychain-reachability'
import { probeMacosKeychainAccess } from './macos-keychain-access-probe'
import { releaseSafeStorageWithhold, withholdSafeStorage } from './safe-storage-availability'

const KEYCHAIN_PROMPT_REASON = 'the macOS keychain is showing an access prompt for this Orca build'

/** Probe headless macOS keychains in a bounded child before secret access; desktop sessions can answer prompts (#25453). */
export async function withholdUnreachableKeychainForServe(
  deps: {
    platform?: NodeJS.Platform
    /** A mock keychain never prompts, so there is nothing to probe. */
    usesMockKeychain?: boolean
    probe?: typeof probeMacosKeychainReachability
    /** Omit to skip the ACL probe (no Electron binary to run it with). */
    accessProbe?: { electronPath: string; appName: string }
    warn?: (message: string) => void
  } = {}
): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'darwin' || deps.usesMockKeychain === true) {
    return
  }
  const warn = deps.warn ?? console.warn
  const reachability = await (deps.probe ?? probeMacosKeychainReachability)()
  if (reachability.kind !== 'unavailable') {
    if (deps.accessProbe) {
      await withholdPromptingKeychainForServe(deps.accessProbe, warn)
    }
    return
  }
  const reason = describeKeychainUnavailable(reachability.reason)
  withholdSafeStorage(reason)
  warn(
    `[secrets] Secrets are unavailable for this run: ${reason}. Orca will not use the keychain until it restarts, so sealed settings such as a saved proxy URL are not applied. Start orca serve from a logged-in desktop session, or unlock the login keychain, to seal credentials.`
  )
}

/** A reachable keychain can still block safeStorage on an ACL dialog after an Electron upgrade; keep serve answering meanwhile. */
async function withholdPromptingKeychainForServe(
  options: { electronPath: string; appName: string },
  warn: (message: string) => void
): Promise<void> {
  const first = probeMacosKeychainAccess(options)
  if ((await first.answer) !== 'prompting') {
    return
  }
  withholdSafeStorage(KEYCHAIN_PROMPT_REASON)
  warn(
    `[secrets] Secrets are unavailable for now: ${KEYCHAIN_PROMPT_REASON}. Choose "Always Allow" in the "${options.appName} Safe Storage" dialog; sealed settings such as the Orca account sign-in are skipped until then.`
  )
  void first.settled.then(async (outcome) => {
    if (outcome !== 'available') {
      warn(`[secrets] The macOS keychain access prompt ended without access (${outcome}).`)
      return
    }
    // "Allow" once grants only the probe; a second silent answer proves "Always Allow" covers this binary.
    if ((await probeMacosKeychainAccess(options).answer) === 'available') {
      releaseSafeStorageWithhold(KEYCHAIN_PROMPT_REASON)
      warn(
        '[secrets] macOS keychain access granted; secrets are available again. Restart orca serve to apply sealed settings read at startup.'
      )
    } else {
      warn(
        '[secrets] macOS keychain access was allowed once, not always; secrets stay unavailable until orca serve restarts.'
      )
    }
  })
}
