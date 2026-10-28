import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_FAILED,
  FILES_DAMAGED,
  FILES_INTACT,
  MANIFEST,
  readySession,
  run
} from './mobile-web-shell-session-test-fixtures'

describe('a failed document checks its files before choosing a recovery', () => {
  // A page render fault reached this path on every entry and cost a full download each time.
  it('checks the files on disk before deciding how to recover a failed document', () => {
    const ready = readySession()
    const step = run(ready.session, DOCUMENT_FAILED)
    expect(step.effects).toEqual([
      { kind: 'verify-generation', buildId: MANIFEST.buildId, pageReady: false }
    ])
    expect(step.session.state).toEqual(ready.session.state)
    expect(step.session.flow).toBe(ready.session.flow + 1)
  })

  it('remounts intact files once, then fails, and never deletes them', () => {
    const first = run(readySession().session, DOCUMENT_FAILED, FILES_INTACT)
    expect(first.effects).toEqual([{ kind: 'remount' }])
    const remounted = run(first.session, { type: 'remounted', sessionId: 'session-two' })
    const second = run(remounted.session, DOCUMENT_FAILED, FILES_INTACT)
    expect(second.effects).toEqual([])
    expect(second.session.state).toEqual({
      kind: 'failed',
      reason: 'document-load-failed',
      retriedOnce: true
    })
  })

  // Page failures and renderer loss keep separate budgets, so neither recovery uses up the other's.
  it('still remounts silently when the renderer dies after a page failure was remounted', () => {
    const recovered = run(readySession().session, DOCUMENT_FAILED, FILES_INTACT, {
      type: 'remounted',
      sessionId: 'session-two'
    })
    const lost = run(recovered.session, { type: 'shell-failed', reason: 'render-process-gone' })
    expect(lost.effects).toEqual([{ kind: 'remount' }])
    expect(lost.session.state.kind).toBe('ready')
  })

  it('still recovers a document that never loads after a renderer-loss remount', () => {
    const remounted = run(
      readySession().session,
      { type: 'shell-failed', reason: 'render-process-gone' },
      { type: 'remounted', sessionId: 'session-two' }
    )
    expect(run(remounted.session, DOCUMENT_FAILED, FILES_INTACT).effects).toEqual([
      { kind: 'remount' }
    ])
    expect(run(remounted.session, DOCUMENT_FAILED, FILES_DAMAGED).effects).toEqual([
      { kind: 'delete-cache' },
      { kind: 'open-cache' }
    ])
  })

  it('lets a renderer-loss remount during the check supersede the check', () => {
    const checking = run(readySession().session, DOCUMENT_FAILED)
    const lost = run(checking.session, { type: 'shell-failed', reason: 'render-process-gone' })
    expect(lost.effects).toEqual([{ kind: 'remount' }])
    const remounted = run(lost.session, { type: 'remounted', sessionId: 'session-two' })
    const late = run(remounted.session, { ...FILES_DAMAGED, flow: checking.session.flow })
    expect(late.effects).toEqual([])
    expect(late.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-two' })
  })

  it('deletes this host cache and runs once more when the files no longer match', () => {
    const step = run(readySession().session, DOCUMENT_FAILED, FILES_DAMAGED)
    expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.session.retriedOnce).toBe(true)
  })

  it('drops a check result once the generation is off screen', () => {
    const failed = run(readySession().session, DOCUMENT_FAILED)
    const retried = run(failed.session, { type: 'retry-pressed' })
    expect(run(retried.session, FILES_DAMAGED).effects).toEqual([])
  })

  it('leaves a page that said ready while its files were checked', () => {
    const checking = run(readySession().session, { type: 'document-loaded' }, DOCUMENT_FAILED)
    const spoke = run(checking.session, { type: 'page-ready' })
    const late = run(spoke.session, FILES_DAMAGED)
    expect(late.effects).toEqual([])
    expect(late.session.state.kind).toBe('ready')
  })

  it('still recovers a page that faults after it said ready', () => {
    const faulted = run(readySession().session, { type: 'page-ready' }, DOCUMENT_FAILED)
    expect(run(faulted.session, { ...FILES_INTACT, pageReady: true }).effects).toEqual([
      { kind: 'remount' }
    ])
  })

  it('fails without a check once the page-failure retry is spent', () => {
    const remounted = run(readySession().session, DOCUMENT_FAILED, FILES_INTACT, {
      type: 'remounted',
      sessionId: 'session-two'
    })
    const again = run(remounted.session, DOCUMENT_FAILED)
    expect(again.effects).toEqual([])
    expect(again.session.state).toEqual({
      kind: 'failed',
      reason: 'document-load-failed',
      retriedOnce: true
    })
  })
})
