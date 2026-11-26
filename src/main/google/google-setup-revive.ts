// The owner's answers that bring a setup run back: Start over makes a new run keeping their choices,
// Continue picks a stopped (failed) run up where it was.
import { randomUUID } from 'node:crypto'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import type { GoogleSetupActor } from './google-setup-rules'
import type { GoogleSetupChange } from './google-setup-runs'

/** The owner's Start over (a new run keeping their choices) and Continue on a stopped run. */
export function revivedGoogleSetupRun(
  current: GoogleSetupRun,
  actor: GoogleSetupActor,
  change: GoogleSetupChange,
  now: number
): GoogleSetupRun | null {
  if (actor !== 'owner' || change.action !== 'answer' || change.card !== 'step') {
    return null
  }
  const answer = { values: change.values, at: now }
  const revision = current.revision + 1
  if (change.values[0] === 'start-over') {
    // An imported app's path isn't kept: its skipped steps start again too.
    const { path: chosen, services, account, kind } = current.answers
    const path = chosen?.values[0] === 'import' ? undefined : chosen
    return {
      id: randomUUID(),
      botId: current.botId,
      state: 'running',
      mode: current.mode,
      steps: {},
      answers: {
        ...(path ? { path } : {}),
        ...(services ? { services } : {}),
        ...(account ? { account } : {}),
        ...(kind ? { kind } : {}),
        step: answer
      },
      // The account, kind, path and services stay (not an imported path); the steps start again.
      ...(current.account ? { account: current.account } : {}),
      ...(current.accounts ? { accounts: current.accounts } : {}),
      ...(current.kind ? { kind: current.kind } : {}),
      ...(current.services ? { services: current.services } : {}),
      ...(current.browserPageId ? { browserPageId: current.browserPageId } : {}),
      ...(current.newApp ? { newApp: true } : {}),
      startedAt: now,
      updatedAt: now,
      revision
    }
  }
  if (change.values[0] === 'resume' && current.state === 'failed') {
    const { lastError: _gone, ...rest } = structuredClone(current)
    return {
      ...rest,
      state: 'running',
      answers: { ...rest.answers, step: answer },
      updatedAt: now,
      revision
    }
  }
  return null
}
