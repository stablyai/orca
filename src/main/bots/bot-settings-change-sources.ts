import { googleSetupRuns } from '../google/google-setup-runs'
import { onBotToolSignInChanged } from './bot-tool-sign-in-changed'
import { onBotToolCredentialEnded } from './bot-tool-credential-ended'

/** What a bot's settings rows show that changes outside its settings: setup cards re-read the bot's
 *  Google setup run, and tool rows re-read on a sign-in or a credential that ends (a tool removed, a
 *  sign-in replaced). Returns the stops. */
export function watchBotSettingsChangeSources(changed: () => void): (() => void)[] {
  return [
    googleSetupRuns().onChange(changed),
    onBotToolSignInChanged(changed),
    onBotToolCredentialEnded(changed)
  ]
}
