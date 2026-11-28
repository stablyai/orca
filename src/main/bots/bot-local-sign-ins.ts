// Whether this computer is signed in to the tools a bot works as its owner with: gh, and a Linear key.
import type { LocalSignIns } from '../../shared/bots/bot-connectors-view'
import { isHostCommandMissing } from '../git/command-runner/hosted-cli/github-cli-host-fallback'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'

const GH_TOKEN_TIMEOUT_MS = 5_000
// Every connector surface shown at once reads it; an owner back from `gh auth login` sees it soon.
const GH_SIGN_IN_FRESH_MS = 15_000
// gh's own words for no login ("no oauth token found for <host>"); a timeout or locked keyring is not one.
const GH_NOT_LOGGED_IN = /no oauth token|not logged in/i

let ghSignIn: { read: Promise<LocalSignIns['gh']>; at: number } | null = null

async function askGhSignIn(): Promise<LocalSignIns['gh']> {
  try {
    const { stdout } = await ghExecFileAsync(['auth', 'token'], { timeout: GH_TOKEN_TIMEOUT_MS })
    return stdout.trim() ? 'signed-in' : 'signed-out'
  } catch (error) {
    if (isHostCommandMissing(error, 'gh')) {
      return 'missing'
    }
    return GH_NOT_LOGGED_IN.test(extractExecError(error).stderr) ? 'signed-out' : undefined
  }
}

/** `gh auth token` reads the keyring (or GH_TOKEN) offline; a token means gh is signed in here. */
export function readGhSignIn(): Promise<LocalSignIns['gh']> {
  const now = Date.now()
  if (!ghSignIn || now - ghSignIn.at >= GH_SIGN_IN_FRESH_MS) {
    ghSignIn = { read: askGhSignIn(), at: now }
  }
  return ghSignIn.read
}
