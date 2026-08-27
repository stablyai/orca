import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publishDocPreviewFailure: vi.fn(),
  boundGrantIdByGuest: new Map<object, string>()
}))

vi.mock('./doc-preview-failure-notice', () => ({
  publishDocPreviewFailure: mocks.publishDocPreviewFailure
}))
vi.mock('./doc-preview-guest-policy', () => ({
  readDocPreviewGuestBoundGrantId: (guest: object) => mocks.boundGrantIdByGuest.get(guest) ?? null
}))

const GRANT_ID = 'a'.repeat(32)
const OTHER_GRANT_ID = 'b'.repeat(32)

/** Only the identity matters: the module asks the guest registry what grant this contents holds. */
function guestBoundTo(grantId: string | null): Electron.WebContents {
  const guest = {} as Electron.WebContents
  if (grantId !== null) {
    mocks.boundGrantIdByGuest.set(guest, grantId)
  }
  return guest
}

async function loadNotifier(): Promise<(guest: Electron.WebContents) => void> {
  const module = await import('./doc-preview-download-block-notice')
  return module.noticeDocPreviewDownloadBlocked
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.boundGrantIdByGuest.clear()
  // Why per test: the module remembers which grants it has already told the reader about.
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('noticeDocPreviewDownloadBlocked', () => {
  it('tells the shell which preview had a download refused', async () => {
    const notice = await loadNotifier()

    notice(guestBoundTo(GRANT_ID))

    expect(mocks.publishDocPreviewFailure).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      reason: 'download-blocked'
    })
  })

  // Why: a document can ask in a loop. The reader learns nothing from the second notice, and every
  // attempt would otherwise cross the IPC boundary and re-render the strip.
  it('says it once however often the document asks', async () => {
    const notice = await loadNotifier()
    const guest = guestBoundTo(GRANT_ID)

    notice(guest)
    notice(guest)
    vi.advanceTimersByTime(1_500)
    notice(guest)

    expect(mocks.publishDocPreviewFailure).toHaveBeenCalledTimes(1)
  })

  it('says it again for an attempt long after the last one', async () => {
    const notice = await loadNotifier()
    const guest = guestBoundTo(GRANT_ID)

    notice(guest)
    vi.advanceTimersByTime(2_500)
    notice(guest)

    expect(mocks.publishDocPreviewFailure).toHaveBeenCalledTimes(2)
  })

  // Why not one throttle for the whole app: two previews are two readers, and silencing the second
  // because the first just refused something leaves that press unexplained.
  it('throttles each preview on its own', async () => {
    const notice = await loadNotifier()

    notice(guestBoundTo(GRANT_ID))
    notice(guestBoundTo(OTHER_GRANT_ID))

    expect(mocks.publishDocPreviewFailure).toHaveBeenCalledTimes(2)
    expect(mocks.publishDocPreviewFailure).toHaveBeenLastCalledWith({
      grantId: OTHER_GRANT_ID,
      reason: 'download-blocked'
    })
  })

  // The absence half of the first test: no shell is showing this contents, so there is no preview
  // to put a notice on. Without the presence tests above, this would pass on a module that never
  // published anything at all.
  it('says nothing for a contents no preview is bound to', async () => {
    const notice = await loadNotifier()

    notice(guestBoundTo(null))

    expect(mocks.publishDocPreviewFailure).not.toHaveBeenCalled()
  })
})
