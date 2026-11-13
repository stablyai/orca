import type { MessageBoxOptions } from 'electron'
import { expect, it, vi } from 'vitest'
import { createInstalledBundleReplacedWatch } from './installed-bundle-replaced-prompt'

vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

it('prompts once when the bundle on disk changed and restarts on the first button', async () => {
  const showMessageBox = vi.fn((_options: MessageBoxOptions) =>
    Promise.resolve({ response: 0, checkboxChecked: false })
  )
  const restart = vi.fn()
  const watch = createInstalledBundleReplacedWatch({
    readChange: () =>
      Promise.resolve({ changed: true, runningVersion: '1.4.255', installedVersion: '1.4.256' }),
    isQuitting: () => false,
    showMessageBox,
    restart,
    recordBreadcrumb: () => undefined,
    now: () => 0
  })

  watch.onAppFocused()
  watch.onAppFocused()
  await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1))

  expect(showMessageBox).toHaveBeenCalledTimes(1)
  expect(showMessageBox.mock.calls[0]?.[0].buttons).toEqual(['Restart Orca', 'Later'])
})
