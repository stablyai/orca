import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '../../components/ui/sonner'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'
import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

let emitSaveNotice: ((notice: ProfileStateSaveNotice) => void) | undefined

// The fixture bridge has no main process; stand in for its profile save notice signal.
function installSaveNoticeBridge(notice: ProfileStateSaveNotice): () => void {
  return () => {
    window.api = {
      ...window.api,
      app: {
        ...window.api.app,
        isProfileStateSaveDelayed: async () => notice,
        onProfileStateSaveDelayChanged: (callback) => {
          emitSaveNotice = callback
          return () => {
            emitSaveNotice = undefined
          }
        }
      }
    }
  }
}

function SaveNotice(): React.JSX.Element {
  useProfileStateSaveDelayNotice()
  return (
    <>
      <div className="h-[900px]" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function waitFor(found: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!found()) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the save notice')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const noticeShown = (): boolean =>
  document.querySelector('[data-sonner-toast][data-mounted="true"]') !== null

function shownFixture(notice: ProfileStateSaveNotice) {
  return defineFixture({
    width: 1280,
    setup: installSaveNoticeBridge(notice),
    render: () => <SaveNotice />,
    interact: async () => {
      await waitFor(noticeShown)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })
}

export const slow = shownFixture('slow')
export const failing = shownFixture('failing')
export const diskFull = shownFixture('disk-full')

export const cleared = defineFixture({
  width: 1280,
  setup: installSaveNoticeBridge('failing'),
  render: () => <SaveNotice />,
  interact: async () => {
    await waitFor(noticeShown)
    emitSaveNotice?.(null)
    await waitFor(() => document.querySelector('[data-sonner-toast]') === null)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
