import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ComposerState, SendSheetState } from './mobile-diff-review-screen-model'

// Which review sheet the user wants; the screen's one keyed drawer decides when it can be shown.

export type ReviewSheet =
  | { kind: 'actions' }
  | { kind: 'send'; load: SendSheetState }
  | { kind: 'discard'; target: MobileDiffReviewQueueItem }
  | { kind: 'composer'; composer: ComposerState }
  | { kind: 'completion' }

export type ReviewSheetKind = ReviewSheet['kind']

export type ReviewSheetsState = {
  requested: ReviewSheet | null
  /** A background sheet waiting for `requested` to close; never of the same kind. */
  deferred: ReviewSheet | null
}

export type ReviewSheetsAction =
  | { type: 'open'; sheet: ReviewSheet }
  | { type: 'openWhenIdle'; sheet: ReviewSheet }
  | { type: 'close'; kind: ReviewSheetKind }
  | { type: 'updateSend'; load: SendSheetState }

export const NO_REVIEW_SHEETS: ReviewSheetsState = { requested: null, deferred: null }

export function reduceReviewSheets(
  state: ReviewSheetsState,
  action: ReviewSheetsAction
): ReviewSheetsState {
  const { requested, deferred } = state
  switch (action.type) {
    case 'open':
      // Why: the newest request wins; a background sheet only survives a refresh of the same sheet.
      return {
        requested: action.sheet,
        deferred: requested?.kind === action.sheet.kind ? deferred : null
      }
    case 'openWhenIdle':
      if (!requested) {
        return { requested: action.sheet, deferred: null }
      }
      // Why: a background opener waits behind the user's sheet and never displaces it.
      if (deferred || requested.kind === action.sheet.kind) {
        return state
      }
      return { requested, deferred: action.sheet }
    case 'close':
      if (requested?.kind === action.kind) {
        return { requested: deferred, deferred: null }
      }
      if (deferred?.kind === action.kind) {
        return { requested, deferred: null }
      }
      return state
    case 'updateSend':
      // Why: a list that resolves after Send Notes was dismissed must not bring it back.
      if (requested?.kind !== 'send') {
        return state
      }
      return { requested: { kind: 'send', load: action.load }, deferred }
  }
}

export function reviewComposer(state: ReviewSheetsState): ComposerState | null {
  return state.requested?.kind === 'composer' ? state.requested.composer : null
}

/** The only ways callers change the review screen's sheets. */
export function reviewSheetIntents(dispatch: (action: ReviewSheetsAction) => void) {
  return {
    openSheet: (sheet: ReviewSheet) => dispatch({ type: 'open', sheet }),
    /** For async openers: waits for the user's sheet to close instead of closing it. */
    openSheetWhenIdle: (sheet: ReviewSheet) => dispatch({ type: 'openWhenIdle', sheet }),
    closeSheet: (kind: ReviewSheetKind) => dispatch({ type: 'close', kind }),
    updateSendSheet: (load: SendSheetState) => dispatch({ type: 'updateSend', load })
  }
}

export type ReviewSheetIntents = ReturnType<typeof reviewSheetIntents>

export function reviewSheetKey(sheet: ReviewSheet): ReviewSheetKind {
  return sheet.kind
}
