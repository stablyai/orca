import { describe, expect, it } from 'vitest'
import { readySession, run } from './mobile-web-shell-session-test-fixtures'
import { shellPageBackClaimed } from './shell-page-back-claim'
import type { MobileWebShellStep } from './mobile-web-shell-session-contract'

/**
 * The device Back key, which the shell hands over only while the page is holding it.
 *
 * A claim that outlived its document would have Back go to a page with nothing to do with it, so
 * every reset path is a case here and the reader is gated on the generation still being on screen.
 */
describe('the page claiming the device Back key', () => {
  function claimed(): MobileWebShellStep {
    return run(
      readySession().session,
      { type: 'page-ready', reports: [] },
      { type: 'page-back-claim', claimed: true }
    )
  }

  it('records the claim and gives it back when the page lets go', () => {
    const held = claimed()
    expect(shellPageBackClaimed(held.session)).toBe(true)
    expect(
      shellPageBackClaimed(run(held.session, { type: 'page-back-claim', claimed: false }).session)
    ).toBe(false)
  })

  it('drops it when a replacement document starts inside this mount', () => {
    expect(shellPageBackClaimed(run(claimed().session, { type: 'document-started' }).session)).toBe(
      false
    )
  })

  it('drops it when the view is remounted under a new session id', () => {
    const remounted = run(claimed().session, { type: 'remounted', sessionId: 'session-two' })
    expect(shellPageBackClaimed(remounted.session)).toBe(false)
  })

  it('drops it when the document asks for a session again, so the page has to claim again', () => {
    const reasked = run(claimed().session, { type: 'page-ready', reports: [] })
    expect(shellPageBackClaimed(reasked.session)).toBe(false)
  })

  it('drops it when a page fault takes the generation off screen', () => {
    const failed = run(claimed().session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(failed.session.state.kind).not.toBe('ready')
    expect(shellPageBackClaimed(failed.session)).toBe(false)
  })

  it('records nothing from a page whose generation is no longer on screen', () => {
    const failed = run(claimed().session, { type: 'shell-failed', reason: 'isolation-unavailable' })
    const late = run(failed.session, { type: 'page-back-claim', claimed: true })
    expect(shellPageBackClaimed(late.session)).toBe(false)
  })
})
