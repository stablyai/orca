// The setup cards Orca writes into a bot's chat as its Google setup run moves. Each is written once,
// on the change that calls for it; the card then draws from the run, so it locks and updates itself.
import { googleSetupCardBody, type GoogleSetupCardRef } from '../../shared/google/google-setup-card'
import {
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep,
  type GoogleSetupRun,
  type GoogleSetupStep
} from '../../shared/google/google-setup-run'
import { writeInChat } from '../bots/bot-chat-status-line'
import { googleSetupRuns } from './google-setup-runs'

/** Whether the step waits on the person: handed to them, or theirs and under way. */
function personsTurn(run: GoogleSetupRun | null, step: GoogleSetupStep): boolean {
  const status = run?.steps[step]?.status
  return (
    status === 'needs-user' ||
    (status === 'active' && run !== null && personDoesGoogleSetupStep(run, step))
  )
}

function answered(run: GoogleSetupRun | null, card: 'path' | 'services' | 'account'): boolean {
  return run?.answers[card] !== undefined
}

/** The cards `next` calls for that `prev` did not; `prev` is null for a new run. */
export function googleSetupCardsDue(
  prev: GoogleSetupRun | null,
  next: GoogleSetupRun
): GoogleSetupCardRef[] {
  const before = prev?.id === next.id ? prev : null
  const ref = (card: GoogleSetupCardRef['card'], step?: GoogleSetupStep): GoogleSetupCardRef => ({
    botId: next.botId,
    runId: next.id,
    card,
    ...(step ? { step } : {})
  })
  if (!before) {
    if (next.state !== 'running') {
      return []
    }
    // Start over keeps the owner's path and services, so it picks up after them.
    if (!answered(next, 'path') || next.mode === 'unchosen') {
      return [ref('path')]
    }
    return [answered(next, 'services') ? ref('progress') : ref('services')]
  }
  if (next.state === 'done') {
    return before.state === 'done' ? [] : [ref('connected')]
  }
  // A stopped setup gets a fresh progress card at the bottom of the chat, with Continue.
  if (next.state === 'failed') {
    return before.state === 'failed' ? [] : [ref('progress')]
  }
  if (next.state !== 'running') {
    return []
  }
  const due: GoogleSetupCardRef[] = []
  const path = next.answers.path?.values[0]
  const imported = path === 'import'
  if (!answered(before, 'path') && answered(next, 'path') && !imported) {
    due.push(next.answers.services ? ref('progress') : ref('services'))
  }
  if (!answered(before, 'services') && answered(next, 'services') && answered(next, 'path')) {
    due.push(ref('progress'))
  }
  if ((next.accounts?.length ?? 0) > 1 && !before.accounts?.length && !answered(next, 'account')) {
    due.push(ref('account'))
  }
  for (const step of GOOGLE_SETUP_STEPS) {
    if (step !== 'connect' && personsTurn(next, step) && !personsTurn(before, step)) {
      due.push(ref('step', step))
    }
  }
  const clientDone = (run: GoogleSetupRun): boolean => {
    const status = run.steps.client?.status
    return status === 'done' || status === 'skipped'
  }
  if (clientDone(next) && !clientDone(before)) {
    due.push(ref('connect'))
  }
  // The key went missing: the progress card's Make a new key goes where the owner is looking.
  if (next.keyMissed && !before.keyMissed && !clientDone(next)) {
    due.push(ref('progress'))
  }
  return due
}

/** The card that holds what the owner must press now, or null while the setup isn't waiting on them. */
export function googleSetupWaitingCard(run: GoogleSetupRun): GoogleSetupCardRef | null {
  if (run.state !== 'running') {
    return null
  }
  const ref = { botId: run.botId, runId: run.id }
  const handed = GOOGLE_SETUP_STEPS.find((step) => personsTurn(run, step) && step !== 'connect')
  if (handed) {
    return { ...ref, card: 'step', step: handed }
  }
  const client = run.steps.client?.status
  if (client === 'done' || client === 'skipped') {
    return { ...ref, card: 'connect' }
  }
  return run.keyMissed ? { ...ref, card: 'progress' } : null
}

// The run revision each run's waiting card was last written again at, so a bot that keeps asking
// before its owner does anything doesn't fill the chat with copies.
// Keyed by bot, so it holds one entry per bot rather than one per run ever started.
const rewrittenAt = new Map<string, { runId: string; revision: number }>()

/**
 * Writes the waiting card again at the bottom of the chat, once per run revision: the copy higher up
 * may be screens away by now. Older copies go quiet on their own.
 */
export function rewriteGoogleSetupWaitingCard(
  chatSessionId: string | undefined,
  run: GoogleSetupRun
): void {
  const card = googleSetupWaitingCard(run)
  const last = rewrittenAt.get(run.botId)
  if (!card || (last?.runId === run.id && last.revision === run.revision)) {
    return
  }
  const [stamped] = googleSetupRuns().stampCards(run.botId, [card])
  // Stamping is itself a change; the next ask on this same run sees its revision and writes nothing.
  rewrittenAt.set(run.botId, {
    runId: run.id,
    revision: googleSetupRuns().get(run.botId)?.revision ?? run.revision
  })
  writeInChat(chatSessionId, googleSetupCardBody(stamped ?? card), 'google-setup')
}

/** Writes the cards a change calls for into the bot's chat; a failed write is logged, never thrown. */
export function writeGoogleSetupCards(
  chatSessionId: string | undefined,
  prev: GoogleSetupRun | null,
  next: GoogleSetupRun
): void {
  const due = googleSetupCardsDue(prev, next)
  if (due.length === 0) {
    return
  }
  for (const ref of googleSetupRuns().stampCards(next.botId, due)) {
    writeInChat(chatSessionId, googleSetupCardBody(ref), 'google-setup')
  }
}
