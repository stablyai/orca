import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  currentGoogleSetupStep,
  personDoesGoogleSetupStep
} from '../../shared/google/google-setup-run'
import { GoogleSetupRuns } from './google-setup-runs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runs() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-google-setup-'))
  dirs.push(dir)
  const path = join(dir, 'orca-google-setup-runs.json')
  let now = 1_000
  return {
    path,
    store: new GoogleSetupRuns(
      () => path,
      () => (now += 1)
    ),
    reopen: () => new GoogleSetupRuns(() => path)
  }
}

describe('Google setup runs', () => {
  it('persists setup progress and lets the bot move to a new browser page after restart', () => {
    const { store, reopen } = runs()
    store.apply('ivy', 'owner', { action: 'start', browserPageId: 'page-1' })
    store.apply('ivy', 'bot', { action: 'step', step: 'account', status: 'done' })
    store.apply('ivy', 'bot', { action: 'set', account: 'dana@acme.com', kind: 'work' })
    store.apply('ivy', 'bot', {
      action: 'need-user',
      step: 'branding',
      note: 'Tick the policy box, then Continue.'
    })
    const run = store.apply('ivy', 'bot', { action: 'step', step: 'project', status: 'done' })
    expect(run.steps.account).toMatchObject({ status: 'done', by: 'bot' })
    expect(run.steps.branding).toMatchObject({ status: 'needs-user' })
    expect(run).toMatchObject({ account: 'dana@acme.com', kind: 'work', browserPageId: 'page-1' })
    expect(currentGoogleSetupStep(run)).toBe('apis')
    expect(run.revision).toBe(5)
    const restarted = reopen()
    expect(restarted.get('ivy')).toEqual(run)
    expect(
      restarted.apply('ivy', 'bot', { action: 'set', browserPageId: 'page-2' }).browserPageId
    ).toBe('page-2')
    expect(reopen().get('ivy')).toMatchObject({ id: run.id, browserPageId: 'page-2' })
  })

  it('lets the bot finish the steps it confirms, in every path', () => {
    const { store } = runs()
    // Guide me in my browser: the person says it's done, and the bot records it.
    store.apply('ivy', 'owner', { action: 'start', mode: 'guide-browser' })
    store.apply('ivy', 'bot', { action: 'step', step: 'project', status: 'done' })
    const told = store.apply('ivy', 'bot', { action: 'step', step: 'apis', status: 'done' })
    expect(told.steps.project?.status).toBe('done')
    expect(told.steps.apis?.status).toBe('done')
    // Guide me here: the person clicked, and the bot read the page to confirm it.
    store.apply('ivy', 'owner', { action: 'start', mode: 'guide-here' })
    const read = store.apply('ivy', 'bot', { action: 'step', step: 'publish', status: 'done' })
    expect(read.steps.publish).toMatchObject({ status: 'done', by: 'user' })
  })

  it('finishes the person’s steps only with their own Done, in every path', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    const theirs = 'Only the person can finish this step'
    // Signing in is theirs even in Do it for me.
    expect(() =>
      store.apply('ivy', 'bot', { action: 'step', step: 'connect', status: 'done' })
    ).toThrow(theirs)
    store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['let-me', 'apis'] })
    expect(() =>
      store.apply('ivy', 'bot', { action: 'step', step: 'apis', status: 'skipped' })
    ).toThrow(theirs)
    store.apply('ivy', 'bot', { action: 'need-user', step: 'publish', note: 'Press Publish.' })
    // Reopening it first doesn't help: a step handed over takes no change from the bot.
    expect(() =>
      store.apply('ivy', 'bot', { action: 'step', step: 'publish', status: 'active' })
    ).toThrow(theirs)
    expect(() =>
      store.apply('ivy', 'bot', { action: 'step', step: 'publish', status: 'done' })
    ).toThrow(theirs)
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'step', values: ['done', 'branding'] })
    ).toThrow(theirs)
    store.apply('ivy', 'bot', { action: 'need-user', step: 'branding', note: 'Tick the box' })
    store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', 'branding'] })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['done', 'apis']
    })
    expect(run.steps.apis).toMatchObject({ status: 'done', by: 'user' })
    expect(run.steps.branding).toMatchObject({ status: 'done', by: 'user' })
    expect(run.personStep).toBeUndefined()
  })

  it('forgets a deleted bot’s run', () => {
    const { store, reopen } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    store.apply('kit', 'owner', { action: 'start' })
    store.forget('ivy')
    expect(store.get('ivy')).toBeNull()
    expect(reopen().get('ivy')).toBeNull()
    expect(reopen().get('kit')).not.toBeNull()
  })

  it('keeps the owner’s path when the bot starts during or after a run', () => {
    const { store } = runs()
    const first = store.apply('ivy', 'owner', { action: 'start' })
    const ownerRun = store.apply('ivy', 'owner', { action: 'start', mode: 'guide-here' })
    expect(ownerRun.id).not.toBe(first.id)
    expect(store.apply('ivy', 'bot', { action: 'start', mode: 'do-it-for-me' })).toEqual(ownerRun)

    store.apply('ivy', 'bot', { action: 'fail', error: 'stuck' })
    expect(() => store.apply('ivy', 'bot', { action: 'start', mode: 'do-it-for-me' })).toThrow(
      'Your owner picks Do it for me'
    )
    expect(store.apply('ivy', 'bot', { action: 'start' }).mode).toBe('guide-here')
    store.apply('ivy', 'bot', { action: 'done' })
    expect(store.apply('ivy', 'bot', { action: 'start' }).mode).toBe('guide-here')
    expect(
      store.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['do-it-for-me'] }).mode
    ).toBe('do-it-for-me')
  })

  it('lets only an owner answer hand the clicking back to the bot', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start', mode: 'guide-here', browserPageId: 'page-1' })
    const refused = 'Only your owner can hand the clicking back to you'
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'path', values: ['do-it-for-me'] })
    ).toThrow(refused)
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'step', values: ['take-over'] })
    ).toThrow(refused)
    expect(() => store.apply('ivy', 'bot', { action: 'cancel' })).toThrow('Only your owner')
    // Handing the clicking to the person is always fine.
    expect(
      store.apply('ivy', 'bot', { action: 'answer', card: 'path', values: ['guide-browser'] })
        .answers.path
    ).toMatchObject({ values: ['guide-browser'], typed: true })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['take-over']
    })
    expect(run.mode).toBe('do-it-for-me')
    expect(run.answers.step?.typed).toBeUndefined()
  })

  it('takes the services and account from their cards, and needs a running setup for changes', () => {
    const { store } = runs()
    expect(() => store.apply('ivy', 'bot', { action: 'done' })).toThrow('No Google setup')
    store.apply('ivy', 'owner', { action: 'start' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'services',
      values: ['gmail', 'calendar', 'chat']
    })
    expect(run.services).toEqual(['gmail', 'calendar'])
    expect(store.apply('ivy', 'bot', { action: 'fail', error: 'Quota' })).toMatchObject({
      state: 'failed',
      lastError: 'Quota'
    })
  })

  it("takes the owner's Done on a step, crediting whoever does that step", () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start', mode: 'guide-here' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['done', 'apis']
    })
    expect(run.steps.apis).toMatchObject({ status: 'done', by: 'user' })
    store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['take-over'] })
    // The app key Orca saved while the bot clicked through is the bot's step.
    expect(
      store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', 'client'] })
        .steps.client
    ).toMatchObject({ status: 'done', by: 'bot' })
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'step', values: ['done', 'connect'] })
    ).toThrow('Only the person')
  })

  it("skips to the owner's sign-in after a team file, and stops on Not now", () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    const imported = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'path',
      values: ['import']
    })
    expect(currentGoogleSetupStep(imported)).toBe('connect')
    expect(imported.mode).toBe('do-it-for-me')
    store.apply('ivy', 'owner', { action: 'start' })
    expect(
      store.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['not-now'] }).state
    ).toBe('cancelled')
    store.apply('ivy', 'owner', { action: 'start' })
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'path', values: ['not-now'] })
    ).toThrow('Only your owner')
  })

  it('credits the owner’s Done and hands back the named or current step on Take over', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    store.apply('ivy', 'bot', { action: 'need-user', step: 'branding', note: 'Tick the box' })
    expect(
      store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', 'branding'] })
        .steps.branding
    ).toMatchObject({ status: 'done', by: 'user' })
    store.apply('ivy', 'bot', { action: 'need-user', step: 'publish', note: 'Publish it' })
    expect(
      store.apply('ivy', 'owner', {
        action: 'answer',
        card: 'step',
        values: ['take-over', 'publish']
      }).steps.publish?.status
    ).toBe('active')

    store.apply('ivy', 'bot', { action: 'need-user', step: 'client', note: 'Create the client.' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['take-over']
    })
    expect(run.steps.client?.status).toBe('active')
    expect(
      store.apply('ivy', 'bot', { action: 'step', step: 'client', status: 'done' }).steps.client
    ).toMatchObject({ status: 'done', by: 'bot' })
  })

  it('reopens the sign-in step when the owner wants a different account', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    store.apply('ivy', 'bot', { action: 'set', account: 'a@x.com' })
    store.apply('ivy', 'bot', { action: 'step', step: 'account', status: 'done' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'account',
      values: ['other']
    })
    expect(run.account).toBeUndefined()
    expect(run.steps.account?.status).toBe('active')
  })

  it("keeps an owner-started run the person's until the path card is answered", () => {
    const { store } = runs()
    const started = store.apply('ivy', 'owner', { action: 'start', mode: 'unchosen' })
    expect(personDoesGoogleSetupStep(started, 'project')).toBe(true)
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'path', values: ['do-it-for-me'] })
    ).toThrow()
    const picked = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'path',
      values: ['do-it-for-me']
    })
    expect(personDoesGoogleSetupStep(picked, 'project')).toBe(false)
  })
})

describe('Google setup recovery answers', () => {
  it("reopens the key step on the owner's Make a new key, and the sign-in after it", () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start', mode: 'do-it-for-me' })
    store.apply('ivy', 'bot', { action: 'step', step: 'client', status: 'done' })
    store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', 'connect'] })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['redo', 'client']
    })
    expect(run.steps.client?.status).toBe('active')
    expect(run.steps.connect).toBeUndefined()
    expect(currentGoogleSetupStep(run)).toBe('account')
  })

  it('picks a stopped setup up again on Continue', () => {
    const { store } = runs()
    const started = store.apply('ivy', 'owner', { action: 'start', mode: 'do-it-for-me' })
    store.apply('ivy', 'bot', { action: 'step', step: 'account', status: 'done' })
    store.apply('ivy', 'bot', { action: 'fail', error: 'No room for another project' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['resume']
    })
    expect(run).toMatchObject({
      id: started.id,
      state: 'running',
      steps: { account: { status: 'done' } }
    })
    expect(run.lastError).toBeUndefined()
    // On a running setup, Continue only wakes the bot.
    expect(
      store.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['resume'] }).steps
    ).toEqual(run.steps)
  })

  it('keeps chosen setup inputs on restart and asks for a path again after import', () => {
    const { store } = runs()
    const first = store.apply('ivy', 'owner', { action: 'start', mode: 'unchosen' })
    store.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['guide-here'] })
    store.apply('ivy', 'owner', { action: 'answer', card: 'services', values: ['gmail'] })
    store.apply('ivy', 'bot', {
      action: 'set',
      account: 'you@gmail.com',
      kind: 'personal',
      projectId: 'orca-old'
    })
    store.apply('ivy', 'bot', { action: 'step', step: 'project', status: 'done' })
    store.apply('ivy', 'bot', { action: 'fail', error: 'The project was removed' })
    const run = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['start-over']
    })
    expect(run.id).not.toBe(first.id)
    expect(run).toMatchObject({
      state: 'running',
      mode: 'guide-here',
      account: 'you@gmail.com',
      kind: 'personal',
      services: ['gmail'],
      steps: {}
    })
    expect(run.projectId).toBeUndefined()
    expect(run.answers.path?.values).toEqual(['guide-here'])

    store.apply('ivy', 'owner', { action: 'start', mode: 'unchosen' })
    store.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['import'] })
    const imported = store.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['start-over']
    })
    expect(imported.answers.path).toBeUndefined()
    expect(imported.steps).toEqual({})
  })

  it('leaves Make a new key, Continue and Start over to the owner', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start', mode: 'do-it-for-me' })
    for (const values of [['redo', 'client'], ['resume'], ['start-over']]) {
      expect(() => store.apply('ivy', 'bot', { action: 'answer', card: 'step', values })).toThrow(
        'Only your owner presses'
      )
    }
    store.apply('ivy', 'bot', { action: 'fail', error: 'stuck' })
    expect(() =>
      store.apply('ivy', 'bot', { action: 'answer', card: 'step', values: ['resume'] })
    ).toThrow('No Google setup is running')
  })

  it('lets the bot finish branding once it reads the policy box ticked, with no Done', () => {
    const { store } = runs()
    store.apply('ivy', 'owner', { action: 'start' })
    store.apply('ivy', 'bot', { action: 'need-user', step: 'branding', note: 'Tick the box' })
    const run = store.apply('ivy', 'bot', { action: 'step', step: 'branding', status: 'done' })
    expect(run.steps.branding?.status).toBe('done')
    // Only finishing: it can't reopen the person's step to work around them.
    store.apply('ivy', 'bot', { action: 'need-user', step: 'links', note: 'Add the links' })
    expect(() =>
      store.apply('ivy', 'bot', { action: 'step', step: 'links', status: 'done' })
    ).toThrow('Only the person can finish this step')
  })
})
