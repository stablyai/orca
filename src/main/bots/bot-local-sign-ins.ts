// Whether this computer is signed in to the tools a bot works as its owner with: gh, and a Linear key.
import type { LocalSignIns } from '../../shared/bots/bot-connectors-view'
import { isHostCommandMissing } from '../git/command-runner/hosted-cli/github-cli-host-fallback'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'

const GH_TOKEN_TIMEOUT_MS = 5_000

/** `gh auth token` reads the keyring (or GH_TOKEN) offline; a token means gh is signed in here. */
export async function readGhSignIn(): Promise<LocalSignIns['gh']> {
  try {
    const { stdout } = await ghExecFileAsync(['auth', 'token'], { timeout: GH_TOKEN_TIMEOUT_MS })
    return stdout.trim() ? 'signed-in' : 'signed-out'
  } catch (error) {
    return isHostCommandMissing(error, 'gh') ? 'missing' : 'signed-out'
  }
}
