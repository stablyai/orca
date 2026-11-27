// Whether this computer is signed in to the tools a bot works as its owner with: gh, and a Linear key.
import type { LocalSignIns } from '../../shared/bots/bot-connectors-view'
import { isHostCommandMissing } from '../git/command-runner/hosted-cli/github-cli-host-fallback'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'

const GH_TOKEN_TIMEOUT_MS = 5_000
// Every connector surface shown at once reads it; an owner back from `gh auth login` sees it soon.
const GH_SIGN_IN_FRESH_MS = 15_000

let ghSignIn: { read: Promise<LocalSignIns['gh']>; at: number } | null = null

async function askGhSignIn(): Promise<LocalSignIns['gh']> {
  try {
    const { stdout } = await ghExecFileAsync(['auth', 'token'], { timeout: GH_TOKEN_TIMEOUT_MS })
    return stdout.trim() ? 'signed-in' : 'signed-out'
  } catch (error) {
    return isHostCommandMissing(error, 'gh') ? 'missing' : 'signed-out'
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
