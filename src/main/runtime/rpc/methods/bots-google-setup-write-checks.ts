// The checks a Google setup write passes before it applies: the key is in Orca, Google answers for
// every chosen service, and the run is still the one the checks read.
import {
  googleSetupRunActive,
  type GoogleSetupRun
} from '../../../../shared/google/google-setup-run'
import type { GoogleStatusView } from '../../../../shared/google/google-connect-types'
import {
  googleSetupDoneRefusal,
  googleSetupKeyBlocker
} from '../../../../shared/google/google-setup-blocker'
import { getGoogleConnect } from '../../../google/google-connect'
import {
  GoogleSetupError,
  googleSetupRuns,
  type GoogleSetupActor,
  type GoogleSetupChange
} from '../../../google/google-setup-runs'
import { InvalidArgumentError } from '../core'

/** Applies a change and returns the run before and after it, for the cards it calls for. */
export function applied(
  botId: string,
  actor: GoogleSetupActor,
  change: GoogleSetupChange
): { prev: GoogleSetupRun | null; run: GoogleSetupRun } {
  const prev = googleSetupRuns().get(botId)
  try {
    return { prev, run: googleSetupRuns().apply(botId, actor, change) }
  } catch (error) {
    if (error instanceof GoogleSetupError) {
      throw new InvalidArgumentError(error.message)
    }
    throw error
  }
}

/** This host's saved key and accounts, or null when Google isn't available here. */
export async function hostGoogle(): Promise<Pick<
  GoogleStatusView,
  'client' | 'accounts' | 'clientKey'
> | null> {
  const connect = getGoogleConnect()
  if (!connect) {
    return null
  }
  const clientKey = await connect.clientCheck()
  return {
    client: await connect.client(),
    accounts: await connect.accounts(),
    ...(clientKey ? { clientKey } : {})
  }
}

/** Whether the setup's key isn't in Orca; no Google here means no key. */
export function keyMissing(
  run: GoogleSetupRun,
  google: Awaited<ReturnType<typeof hostGoogle>>
): boolean {
  return !google || googleSetupKeyBlocker(run, google) !== null
}

/** The bot marks client done only once the key reached Orca, so a missed download shows at once. */
export async function refuseClientDoneWithoutKey(
  botId: string,
  run: GoogleSetupRun | null,
  change: GoogleSetupChange
): Promise<void> {
  if (change.action !== 'step' || change.step !== 'client' || change.status !== 'done' || !run) {
    return
  }
  if (keyMissing(run, await hostGoogle())) {
    // The bot is past Download JSON: the key went missing, so the owner's card offers the recovery.
    // Once: a bot asking again must not make a new change (and a new card) each time. Only on the
    // run it checked: the owner may have stopped or replaced it meanwhile.
    const current = googleSetupRuns().get(botId)
    if (current?.id === run.id && googleSetupRunActive(current) && !current.keyMissed) {
      applied(botId, 'owner', { action: 'key-missed' })
    }
    throw new InvalidArgumentError(
      "Orca doesn't have this setup's key, so client isn't done. Your owner's card shows: Make a new key · Import a key file."
    )
  }
}

/** A bot's write applies only to the run its checks read; the owner may stop or replace it during them. */
export function requireUnchangedRun(botId: string, checked: GoogleSetupRun | null): void {
  if (checked && googleSetupRuns().get(botId)?.id !== checked.id) {
    throw new InvalidArgumentError(
      'This Google setup changed while Orca checked it. Run `orca bot google-setup show` and carry on from there.'
    )
  }
}

/** A bot's `done` stands only once Google answers for every chosen service. */
export async function refuseUnfinishedDone(run: GoogleSetupRun | null): Promise<void> {
  if (run?.state !== 'running') {
    return
  }
  const connect = getGoogleConnect()
  if (!connect) {
    throw new InvalidArgumentError("Google isn't available on this computer.")
  }
  // A fresh read, so a box ticked on a second sign-in counts; the saved one when Google can't be reached.
  const [accounts, clientKey] = await Promise.all([
    connect.checkAccounts().catch(() => connect.accounts()),
    connect.checkClient()
  ])
  const refusal = googleSetupDoneRefusal(run, {
    client: await connect.client(),
    accounts,
    ...(clientKey ? { clientKey } : {})
  })
  if (refusal) {
    throw new InvalidArgumentError(`${refusal} Run done again once it's sorted.`)
  }
}
