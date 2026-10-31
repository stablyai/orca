import type { TranscriptQuestionMaterialization as RefreshResult } from './transcript-question-publication'

export type RefreshCredit = {
  promise: Promise<RefreshResult>
  resolve: (result: RefreshResult) => void
  reject: (error: unknown) => void
  materialize: boolean
}

export function createTranscriptQuestionRefreshCredit(materialize: boolean): RefreshCredit {
  let resolve!: (result: RefreshResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<RefreshResult>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject, materialize }
}
