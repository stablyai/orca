// What a Google setup run needs from the host that runs its agent, desktop or server: the key taken
// as it downloads, wherever the page's browser runs, and the Create dialog's secret kept out of the
// agent's click effects. Each host installs this once; only its own browser, if any, is an adapter.
import { setPageTextWithheld } from '../browser/agent-browser/agent-browser-withheld-page-text'
import type { StandingDownloadClaimResolver } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import { setCommittedBrowserDownloadClaim } from '../runtime/browser/downloads/browser-client-download-claim'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  answerGoogleSetupCard,
  recordGoogleSetupKeyMissed
} from '../runtime/rpc/methods/bots-google-setup'
import { getGoogleConnect } from './google-connect'
import {
  googleSetupCommittedKeyClaim,
  googleSetupKeyDownloadClaim,
  googleSetupWithholdsPageText,
  type GoogleSetupKeyDownloadDeps
} from './google-setup-key-download'
import { googleSetupRuns } from './google-setup-runs'

export type GoogleSetupHostBrowser = {
  /** This host's own browser (a desktop window or an offscreen one) saves its downloads here. */
  setStandingDownloadClaim(resolver: StandingDownloadClaimResolver | null): void
}

/** Installs the watches; the returned function removes them. */
export function installGoogleSetupHostWatch(
  runtime: OrcaRuntimeService,
  browser?: GoogleSetupHostBrowser
): () => void {
  const deps: GoogleSetupKeyDownloadDeps = {
    runs: () => googleSetupRuns().list(),
    importKey: async (text) => {
      const connect = getGoogleConnect()
      if (!connect) {
        throw new Error("Google isn't available on this computer.")
      }
      await connect.importClient(text)
    },
    keyArrived: (botId) =>
      answerGoogleSetupCard(runtime, botId, 'owner', 'step', ['done', 'client']),
    keyRefused: (botId, reason) => recordGoogleSetupKeyMissed(runtime, botId, reason)
  }
  browser?.setStandingDownloadClaim(googleSetupKeyDownloadClaim(deps))
  // A paired desktop's browser streams the download here; the file channel saves it, then offers it.
  setCommittedBrowserDownloadClaim(googleSetupCommittedKeyClaim(deps))
  // The Create dialog shows the client secret: no click's effects may read that page back.
  setPageTextWithheld((page) => googleSetupWithholdsPageText(googleSetupRuns().list(), page))
  return () => {
    browser?.setStandingDownloadClaim(null)
    setCommittedBrowserDownloadClaim(null)
    setPageTextWithheld(null)
  }
}
