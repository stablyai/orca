import { describe, expect, it, vi } from 'vitest'
import {
  DesktopOwnedBrowserViewAdmission,
  DesktopOwnedBrowserViewAdmissionError,
  isDesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

const identity = {
  browserPageId: 'new-page',
  workspaceId: 'workspace',
  worktreeId: 'worktree',
  sessionProfileId: 'profile',
  rendererWebContentsId: 8
}

describe('DesktopOwnedBrowserViewAdmission', () => {
  it('mints immutable provenance only after known-session policy attachment', () => {
    const fixture = createOwnedViewFixture()
    const events: string[] = []
    const admission = new DesktopOwnedBrowserViewAdmission({
      isKnownPartition: () => 'persist:owned',
      getSession: () => fixture.record.session,
      createView: () => {
        events.push('create')
        return fixture.view
      },
      attachPolicies: () => {
        events.push('policy')
      }
    })
    const record = admission.create(identity)
    expect(events).toEqual(['create', 'policy'])
    expect(isDesktopOwnedBrowserViewRecord(record)).toBe(true)
    expect(isDesktopOwnedBrowserViewRecord({ ...record })).toBe(false)
    expect(Object.isFrozen(record)).toBe(true)
    expect(record.generation).not.toBe(fixture.record.generation)
  })

  it('rejects an unknown profile before creating or attaching policy to a view', () => {
    const fixture = createOwnedViewFixture()
    const createView = vi.fn(() => fixture.view)
    const attachPolicies = vi.fn()
    const admission = new DesktopOwnedBrowserViewAdmission({
      isKnownPartition: () => null,
      getSession: () => fixture.record.session,
      createView,
      attachPolicies
    })
    expect(() => admission.create(identity)).toThrow('known session profile')
    expect(createView).not.toHaveBeenCalled()
    expect(attachPolicies).not.toHaveBeenCalled()
  })

  it('keeps failed admission cleanup pending until the actual destroyed event', async () => {
    const fixture = createOwnedViewFixture({ autoDestroy: false })
    const other = createOwnedViewFixture()
    const attachPolicies = vi.fn()
    const admission = new DesktopOwnedBrowserViewAdmission({
      isKnownPartition: () => 'persist:owned',
      getSession: () => other.record.session,
      createView: () => fixture.view,
      attachPolicies
    })
    let failure: DesktopOwnedBrowserViewAdmissionError | null = null
    try {
      admission.create(identity)
    } catch (error) {
      if (!(error instanceof DesktopOwnedBrowserViewAdmissionError)) {
        throw error
      }
      failure = error
    }
    if (!failure) {
      throw new Error('Expected failed admission')
    }
    let completed = false
    void failure.cleanup.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(attachPolicies).not.toHaveBeenCalled()
    expect(fixture.guest.closeCalls).toBe(1)
    fixture.guest.finishClose()
    await failure.cleanup
    expect(completed).toBe(true)
    await other.controller.close()
  })

  it('retains an observable cleanup result when policy installation throws', async () => {
    const fixture = createOwnedViewFixture()
    const admission = new DesktopOwnedBrowserViewAdmission({
      isKnownPartition: () => 'persist:owned',
      getSession: () => fixture.record.session,
      createView: () => fixture.view,
      attachPolicies: () => {
        throw new Error('policy install failed')
      }
    })
    try {
      admission.create(identity)
      throw new Error('Expected policy failure')
    } catch (error) {
      if (!(error instanceof DesktopOwnedBrowserViewAdmissionError)) {
        throw error
      }
      expect(error.message).toBe('policy install failed')
      await error.cleanup
      expect(fixture.guest.destroyed).toBe(true)
    }
  })
})
