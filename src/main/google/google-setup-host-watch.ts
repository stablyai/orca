// What a Google setup run needs from the host that runs its agent, desktop or server: the key taken
// as its download starts, wherever the page's browser runs, and the agent shown nothing of its own
// browser while Google may show the client secret. Each host installs this once; its own browser,
// if any, is the only adapter.
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { googleSetupMayShowSecret } from '../../shared/google/google-setup-run'
import { setPageTextWithheld } from '../browser/agent-browser/agent-browser-withheld-page-text'
import type { StandingDownloadClaimResolver } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import { setClientDownloadClaimant } from '../runtime/browser/downloads/client-download-claims'
import { setBrowserWorkspaceWithheld } from '../runtime/browser/withholding/browser-command-withholding'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  answerGoogleSetupCard,
  recordGoogleSetupKeyMissed
} from '../runtime/rpc/methods/bots-google-setup'
import { getGoogleConnect } from './google-connect'
import {
  googleSetupClientDownloadClaimant,
  googleSetupKeyDownloadClaim,
  googleSetupWithholdsPageText,
  type GoogleSetupKeyDownloadDeps
} from './google-setup-key-download'
import { googleSetupRuns } from './google-setup-runs'

export type GoogleSetupHostBrowser = {
  /** This host's own browser (a desktop window or an offscreen one) saves its downloads here. */
  setStandingDownloadClaim(resolver: StandingDownloadClaimResolver | null): void
  getWorktreeIdForTab(browserPageId: string): string | undefined
  /** Orca's own folder for a key while it's imported; never a workspace. */
  keyStagingDir: string
}

/** Installs the watches; the returned function removes them. */
export function installGoogleSetupHostWatch(
  runtime: OrcaRuntimeService,
  browser?: GoogleSetupHostBrowser
): () => void {
  const botWorkspace = (botId: string): string | null => {
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    return bot ? folderWorkspaceKey(bot.folderWorkspaceId) : null
  }
  const deps: GoogleSetupKeyDownloadDeps = {
    runs: () => googleSetupRuns().list(),
    botWorkspace,
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
  browser?.setStandingDownloadClaim(
    googleSetupKeyDownloadClaim(deps, {
      stagingDir: browser.keyStagingDir,
      workspaceOfPage: (id) => browser.getWorktreeIdForTab(id) ?? null
    })
  )
  setClientDownloadClaimant(googleSetupClientDownloadClaimant(deps))
  // A command naming no workspace may act on the setup's tab, so any secret-showing run holds it.
  setBrowserWorkspaceWithheld((workspaceId) =>
    googleSetupRuns()
      .list()
      .some(
        (run) =>
          googleSetupMayShowSecret(run) &&
          (workspaceId === null || botWorkspace(run.botId) === workspaceId)
      )
  )
  // After the run ends the dialog may still be open: this host's own browser still keeps its text
  // out of click effects while the page is Google's client page.
  setPageTextWithheld((page) => googleSetupWithholdsPageText(googleSetupRuns().list(), page))
  return () => {
    browser?.setStandingDownloadClaim(null)
    setClientDownloadClaimant(null)
    setBrowserWorkspaceWithheld(null)
    setPageTextWithheld(null)
  }
}
