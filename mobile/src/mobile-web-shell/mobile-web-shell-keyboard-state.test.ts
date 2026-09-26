import { describe, expect, it } from 'vitest'
import { readySession, run } from './mobile-web-shell-session-test-fixtures'
import { BRIDGE_KEYBOARD_INSET_ACCEPT } from './bridge/bridge-keyboard-inset'
import { shellPageReadsKeyboardInset } from './page-document-state'

/** Whether the shell may let the keyboard cover the view, which only the document on screen can say. */
describe('the page declaring it reads the keyboard from init', () => {
  const reads = () =>
    run(readySession().session, {
      type: 'page-ready',
      reports: [],
      accepts: [BRIDGE_KEYBOARD_INSET_ACCEPT]
    })

  it('is read off the ready that declared it', () => {
    expect(shellPageReadsKeyboardInset(reads().session)).toBe(true)
  })

  it('is false for a page that did not declare it, which is every page before the name', () => {
    const older = run(readySession().session, { type: 'page-ready', reports: [], accepts: [] })
    expect(shellPageReadsKeyboardInset(older.session)).toBe(false)
  })

  it('is dropped when a replacement document starts, so the next one has to say it again', () => {
    const started = run(reads().session, { type: 'document-started' })
    expect(shellPageReadsKeyboardInset(started.session)).toBe(false)
  })

  it('is not read once the generation is off screen', () => {
    const failed = run(reads().session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(shellPageReadsKeyboardInset(failed.session)).toBe(false)
  })
})
