import { describe, expect, it } from 'vitest'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { SendSheetState } from './mobile-diff-review-screen-model'
import {
  NO_REVIEW_SHEETS,
  reduceReviewSheets,
  reviewComposer,
  type ReviewSheet,
  type ReviewSheetsAction,
  type ReviewSheetsState
} from './mobile-diff-review-sheets'

const ACTIONS: ReviewSheet = { kind: 'actions' }
const COMPLETION: ReviewSheet = { kind: 'completion' }
const SEND_LOADING: ReviewSheet = { kind: 'send', load: { kind: 'loading' } }
const COMPOSER: ReviewSheet = { kind: 'composer', composer: { mode: 'create', lineNumber: 4 } }
const READY: SendSheetState = { kind: 'ready', terminals: [] }
const DISCARD_TARGET: MobileDiffReviewQueueItem = {
  key: 'unstaged:src/a.ts',
  scope: 'unstaged',
  area: 'unstaged',
  filePath: 'src/a.ts',
  status: 'modified',
  title: 'a.ts',
  subtitle: 'src',
  canStage: true,
  canUnstage: false,
  canDiscard: true,
  isGeneratedOrLockFile: false,
  diffIdentity: 'identity-1',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
}

function run(...actions: ReviewSheetsAction[]): ReviewSheetsState {
  return actions.reduce(reduceReviewSheets, NO_REVIEW_SHEETS)
}

const open = (sheet: ReviewSheet): ReviewSheetsAction => ({ type: 'open', sheet })
const openWhenIdle = (sheet: ReviewSheet): ReviewSheetsAction => ({ type: 'openWhenIdle', sheet })
const close = (kind: ReviewSheet['kind']): ReviewSheetsAction => ({ type: 'close', kind })
const updateSend = (load: SendSheetState): ReviewSheetsAction => ({ type: 'updateSend', load })
const DISCARD: ReviewSheet = { kind: 'discard', target: DISCARD_TARGET }

describe('review screen sheet requests', () => {
  it('the newest request wins', () => {
    expect(run(open(ACTIONS))).toEqual({ requested: ACTIONS, deferred: null })
    expect(run(open(ACTIONS), open(SEND_LOADING), open(COMPOSER))).toEqual({
      requested: COMPOSER,
      deferred: null
    })
  })

  it('closing a sheet clears the request only for that sheet', () => {
    expect(run(open(DISCARD), close('discard'))).toEqual(NO_REVIEW_SHEETS)
    const state = run(open(ACTIONS))
    expect(reduceReviewSheets(state, close('send'))).toBe(state)
  })

  it('exposes the requested composer only', () => {
    expect(reviewComposer(run(open(COMPOSER)))).toEqual({ mode: 'create', lineNumber: 4 })
    expect(reviewComposer(run(open(COMPOSER), close('composer')))).toBeNull()
  })

  it('openWhenIdle opens at once when nothing is requested', () => {
    expect(run(openWhenIdle(COMPLETION))).toEqual({ requested: COMPLETION, deferred: null })
  })

  it('openWhenIdle waits behind the user sheet and opens when it closes', () => {
    const waiting = run(open(ACTIONS), openWhenIdle(COMPLETION))
    expect(waiting).toEqual({ requested: ACTIONS, deferred: COMPLETION })
    expect(reduceReviewSheets(waiting, close('actions'))).toEqual({
      requested: COMPLETION,
      deferred: null
    })
  })

  // Review Complete → Send Notes, then a second Mark Reviewed save lands while Review Complete is
  // still closing: Send Notes must stay the request.
  it('a late Review Complete never displaces a sheet the user asked for', () => {
    const state = run(open(COMPLETION), open(SEND_LOADING), openWhenIdle(COMPLETION))
    expect(state.requested).toEqual(SEND_LOADING)
    expect(run(open(ACTIONS), open(SEND_LOADING), openWhenIdle(COMPLETION)).requested).toEqual(
      SEND_LOADING
    )
  })

  it('openWhenIdle does not repeat a sheet that is already requested or waiting', () => {
    const shown = run(openWhenIdle(COMPLETION))
    expect(reduceReviewSheets(shown, openWhenIdle(COMPLETION))).toBe(shown)
    const waiting = run(open(ACTIONS), openWhenIdle(COMPLETION))
    expect(reduceReviewSheets(waiting, openWhenIdle(COMPLETION))).toBe(waiting)
  })

  it('moving to another sheet drops a waiting background sheet', () => {
    expect(run(open(ACTIONS), openWhenIdle(COMPLETION), open(SEND_LOADING))).toEqual({
      requested: SEND_LOADING,
      deferred: null
    })
  })

  it('refreshing the requested sheet keeps a waiting background sheet', () => {
    const edit: ReviewSheet = { kind: 'composer', composer: { mode: 'create', lineNumber: 9 } }
    expect(run(open(COMPOSER), openWhenIdle(COMPLETION), open(edit))).toEqual({
      requested: edit,
      deferred: COMPLETION
    })
  })

  it('closing a waiting background sheet leaves the user sheet alone', () => {
    expect(run(open(ACTIONS), openWhenIdle(COMPLETION), close('completion'))).toEqual({
      requested: ACTIONS,
      deferred: null
    })
  })

  it('updateSend fills a requested Send Notes', () => {
    expect(run(open(SEND_LOADING), updateSend(READY)).requested).toEqual({
      kind: 'send',
      load: READY
    })
  })

  it('a send list that lands after Send Notes was dismissed does not bring it back', () => {
    const dismissed = run(open(SEND_LOADING), close('send'))
    expect(reduceReviewSheets(dismissed, updateSend(READY))).toBe(dismissed)
    const moved = run(open(SEND_LOADING), open(ACTIONS))
    expect(reduceReviewSheets(moved, updateSend(READY))).toBe(moved)
  })

  it('never waits a sheet behind nothing or behind its own kind', () => {
    const sheets = [ACTIONS, COMPLETION, SEND_LOADING, COMPOSER, DISCARD]
    const actions: ReviewSheetsAction[] = [updateSend(READY)]
    for (const sheet of sheets) {
      actions.push(open(sheet), openWhenIdle(sheet), close(sheet.kind))
    }
    let seed = 7
    let state = NO_REVIEW_SHEETS
    for (let step = 0; step < 2000; step++) {
      seed = (seed * 48271) % 2147483647
      state = reduceReviewSheets(state, actions[seed % actions.length]!)
      if (state.deferred !== null) {
        expect(state.requested).not.toBeNull()
        expect(state.deferred.kind).not.toBe(state.requested?.kind)
      }
    }
  })
})
