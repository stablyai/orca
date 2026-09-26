import { describe, expect, it } from 'vitest'
import { readySession, run } from './mobile-web-shell-session-test-fixtures'
import { BRIDGE_SAFE_AREA_ACCEPT } from './bridge/bridge-safe-area-insets'
import { shellPageOwnsSafeArea } from './page-document-state'

/** Whether the shell may draw the view edge-to-edge, which only the document on screen can say. */
describe('the page declaring it pads for the system bars', () => {
  const owned = () =>
    run(readySession().session, {
      type: 'page-ready',
      reports: [],
      accepts: [BRIDGE_SAFE_AREA_ACCEPT]
    })

  it('is read off the ready that declared it', () => {
    expect(shellPageOwnsSafeArea(owned().session)).toBe(true)
  })

  it('is false for a page that did not declare it, which is every page before the name', () => {
    const older = run(readySession().session, { type: 'page-ready', reports: [], accepts: [] })
    expect(shellPageOwnsSafeArea(older.session)).toBe(false)
  })

  it('is dropped when a replacement document starts, so the next one has to say it again', () => {
    expect(shellPageOwnsSafeArea(run(owned().session, { type: 'document-started' }).session)).toBe(
      false
    )
  })

  it('is not read once the generation is off screen', () => {
    const failed = run(owned().session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(shellPageOwnsSafeArea(failed.session)).toBe(false)
  })
})
