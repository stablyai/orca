import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '../../components/ui/sonner'
import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

let emitSaveDelay: ((delayed: boolean) => void) | undefined

// The fixture bridge has no main process; stand in for its profile-storage delay signal.
function installSaveDelayBridge(): void {
  window.api = {
    ...window.api,
    app: {
      ...window.api.app,
      isProfileStateSaveDelayed: async () => true,
      onProfileStateSaveDelayChanged: (callback) => {
        emitSaveDelay = callback
        return () => {
          emitSaveDelay = undefined
        }
      }
    }
  }
}

function SaveDelayNotice(): React.JSX.Element {
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
      throw new Error('Timed out waiting for the save-delay notice')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const noticeShown = (): boolean =>
  document.querySelector('[data-sonner-toast][data-mounted="true"]') !== null

export const delayed = defineFixture({
  width: 1280,
  setup: installSaveDelayBridge,
  render: () => <SaveDelayNotice />,
  interact: async () => {
    await waitFor(noticeShown)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

export const cleared = defineFixture({
  width: 1280,
  setup: installSaveDelayBridge,
  render: () => <SaveDelayNotice />,
  interact: async () => {
    await waitFor(noticeShown)
    emitSaveDelay?.(false)
    await waitFor(() => document.querySelector('[data-sonner-toast]') === null)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
