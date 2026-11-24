// Each bot's Google setup run on this computer, saved beside this runtime's data so it survives a
// restart. The bot moves it with `orca bot google-setup`; the owner's card answers change its path.
// Nothing a bot sends can hand itself the clicks back: only an owner answer leaves Guide me here.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  GoogleSetupRunSchema,
  type GoogleSetupCard,
  type GoogleSetupRunMode,
  type GoogleSetupRun,
  type GoogleSetupStep,
  type GoogleSetupStepStatus
} from '../../shared/google/google-setup-run'
import type { GoogleServiceChoice } from '../../shared/google/google-scopes'
import { googleSetupCardKey, type GoogleSetupCardRef } from '../../shared/google/google-setup-card'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { getDataFile } from '../persistence/loading-store/user-data-path'
import {
  botClicks,
  GOOGLE_SETUP_FINISHED_OUTSIDE_NOTE,
  GoogleSetupError,
  isPersonOwnedStep,
  lateDone,
  PERSON_FINISHES,
  recordAnswer,
  startMode,
  type GoogleSetupActor
} from './google-setup-rules'
import { revivedGoogleSetupRun } from './google-setup-revive'

export { GoogleSetupError, isPersonOwnedStep, type GoogleSetupActor }

const FileSchema = z.object({ runs: z.record(z.string(), GoogleSetupRunSchema).default({}) })

export type GoogleSetupChange =
  | { action: 'start'; mode?: GoogleSetupRunMode; browserPageId?: string; newApp?: true }
  | {
      action: 'step'
      step: GoogleSetupStep
      status: Exclude<GoogleSetupStepStatus, 'needs-user'>
      note?: string
    }
  | { action: 'need-user'; step: GoogleSetupStep; note: string }
  | {
      action: 'set'
      account?: string
      accounts?: string[]
      kind?: 'work' | 'personal'
      projectId?: string
      services?: GoogleServiceChoice[]
      browserPageId?: string
    }
  | { action: 'answer'; card: GoogleSetupCard; values: string[] }
  | { action: 'done' }
  /** Orca's own reading that the key didn't arrive; never sent by a bot. */
  | { action: 'key-missed'; reason?: string }
  /** Orca's own reading that a working sign-in shows these steps finished; never sent by a bot. */
  | { action: 'finished-outside'; steps: GoogleSetupStep[] }
  | { action: 'fail'; error: string }
  | { action: 'cancel' }

export class GoogleSetupRuns {
  private runs: Record<string, GoogleSetupRun> | null = null
  private readonly listeners = new Set<(run: GoogleSetupRun) => void>()

  constructor(
    private readonly path: () => string = () =>
      join(dirname(getDataFile()), 'orca-google-setup-runs.json'),
    private readonly now: () => number = Date.now
  ) {}

  /** Drops a deleted bot's run. */
  forget(botId: string): void {
    const runs = this.all()
    if (!(botId in runs)) {
      return
    }
    const { [botId]: _gone, ...rest } = runs
    mkdirSync(dirname(this.path()), { recursive: true })
    writeFileAtomically(this.path(), `${JSON.stringify({ runs: rest })}\n`)
    this.runs = rest
  }

  get(botId: string): GoogleSetupRun | null {
    return this.all()[botId] ?? null
  }

  list(): GoogleSetupRun[] {
    return Object.values(this.all())
  }

  /** Numbers the copies of cards about to be written; the run then names each card's newest. */
  stampCards(botId: string, refs: GoogleSetupCardRef[]): GoogleSetupCardRef[] {
    const current = this.get(botId)
    if (!current || !refs.some((ref) => ref.runId === current.id)) {
      return refs
    }
    const copies = { ...current.cardCopies }
    const stamped = refs.map((ref) => {
      if (ref.runId !== current.id) {
        return ref
      }
      const key = googleSetupCardKey(ref)
      const copy = key in copies ? copies[key] + 1 : 0
      copies[key] = copy
      return copy > 0 ? { ...ref, copy } : ref
    })
    // Not a step forward, so `updatedAt` (which Paused reads) stays.
    this.save({ ...current, cardCopies: copies, revision: current.revision + 1 })
    return stamped
  }

  /** Called after every change, with the run as saved. */
  onChange(listener: (run: GoogleSetupRun) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  apply(botId: string, actor: GoogleSetupActor, change: GoogleSetupChange): GoogleSetupRun {
    const now = this.now()
    const current = this.get(botId)
    if (change.action === 'start') {
      // A bot resumes a running setup rather than restarting it, which could lift Guide me here.
      // A new-app start only marks it: a running setup already makes its own app, and a key saved during it counts.
      // One that imported the team's file makes none, so a new app starts over.
      const imported = current?.answers.path?.values[0] === 'import'
      if (
        current?.state === 'running' &&
        (actor === 'bot' || change.newApp) &&
        !(change.newApp && imported)
      ) {
        return change.newApp && !current.newApp
          ? this.save({ ...current, newApp: true, updatedAt: now, revision: current.revision + 1 })
          : current
      }
      return this.save({
        id: randomUUID(),
        botId,
        state: 'running',
        mode: startMode(actor, change.mode),
        steps: {},
        answers: {},
        ...(change.browserPageId ? { browserPageId: change.browserPageId } : {}),
        ...(change.newApp ? { newApp: true } : {}),
        startedAt: now,
        updatedAt: now,
        revision: (current?.revision ?? 0) + 1
      })
    }
    const revived = current ? revivedGoogleSetupRun(current, actor, change, now) : null
    if (revived) {
      return this.save(revived)
    }
    // A second Stop (a double click, another device) is already done.
    if (change.action === 'cancel' && actor === 'owner' && current?.state === 'cancelled') {
      return current
    }
    if (current?.state === 'cancelled') {
      throw new GoogleSetupError(
        'Your owner stopped this Google setup. Start it again only if they ask.'
      )
    }
    if (current?.state === 'done' && lateDone(change)) {
      return current
    }
    if (current?.state !== 'running') {
      throw new GoogleSetupError(
        'No Google setup is running for this bot. Start one with `orca bot google-setup start`.'
      )
    }
    const next: GoogleSetupRun = structuredClone(current)
    applyChange(next, actor, change, now)
    next.updatedAt = now
    next.revision = current.revision + 1
    return this.save(next)
  }

  private all(): Record<string, GoogleSetupRun> {
    if (!this.runs) {
      try {
        this.runs = FileSchema.parse(JSON.parse(readFileSync(this.path(), 'utf-8'))).runs
      } catch {
        this.runs = {}
      }
    }
    return this.runs
  }

  private save(run: GoogleSetupRun): GoogleSetupRun {
    const runs = { ...this.all(), [run.botId]: run }
    mkdirSync(dirname(this.path()), { recursive: true })
    writeFileAtomically(this.path(), `${JSON.stringify({ runs })}\n`)
    this.runs = runs
    for (const listener of this.listeners) {
      listener(run)
    }
    return run
  }
}

function applyChange(
  run: GoogleSetupRun,
  actor: GoogleSetupActor,
  change: Exclude<GoogleSetupChange, { action: 'start' }>,
  now: number
): void {
  switch (change.action) {
    case 'step': {
      const finishes = change.status === 'done' || change.status === 'skipped'
      // Other steps the bot confirms by reading the page, in any path. A step it handed the person
      // stays theirs: no status change from the bot, so it can't reopen it to finish it.
      if (
        actor === 'bot' &&
        // Branding's policy box is the person's tick; once the bot reads it ticked it may finish
        // branding, so ticking is enough without Done.
        !(change.step === 'branding' && change.status === 'done') &&
        (run.steps[change.step]?.status === 'needs-user' ||
          (finishes && isPersonOwnedStep(run, change.step)))
      ) {
        throw new GoogleSetupError(PERSON_FINISHES)
      }
      const by =
        change.status === 'done' ? (botClicks(run, change.step) ? 'bot' : 'user') : undefined
      run.steps[change.step] = {
        status: change.status,
        at: now,
        ...(by ? { by } : {}),
        ...(change.note ? { note: change.note } : {})
      }
      if (change.step === 'client') {
        delete run.keyMissed
      }
      // "Let me do this one" ends with that step.
      if (change.status === 'done' && run.personStep === change.step) {
        delete run.personStep
      }
      return
    }
    case 'need-user':
      run.steps[change.step] = { status: 'needs-user', at: now, note: change.note }
      return
    case 'set': {
      // The page can move freely (say, after a restart closed it): nothing locks it.
      Object.assign(run, definedOnly(change))
      return
    }
    case 'answer':
      recordAnswer(run, actor, change.card, change.values, now)
      return
    case 'key-missed':
      run.keyMissed = { at: now, ...(change.reason ? { reason: change.reason } : {}) }
      return
    case 'finished-outside':
      if (actor === 'bot') {
        throw new GoogleSetupError(PERSON_FINISHES)
      }
      for (const step of change.steps) {
        const status = run.steps[step]?.status
        if (status !== 'done' && status !== 'skipped') {
          run.steps[step] = { status: 'done', at: now, note: GOOGLE_SETUP_FINISHED_OUTSIDE_NOTE }
          if (run.personStep === step) {
            delete run.personStep
          }
        }
      }
      return
    case 'done':
      run.state = 'done'
      delete run.personStep
      return
    case 'fail':
      run.state = 'failed'
      run.lastError = change.error
      return
    case 'cancel':
      if (actor === 'bot') {
        throw new GoogleSetupError('Only your owner can stop the setup.')
      }
      run.state = 'cancelled'
  }
}

function definedOnly(change: Extract<GoogleSetupChange, { action: 'set' }>) {
  const { action: _action, ...fields } = change
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

let installed: GoogleSetupRuns | null = null

/** This runtime's setup runs, created on first use. */
export function googleSetupRuns(): GoogleSetupRuns {
  installed ??= new GoogleSetupRuns()
  return installed
}
