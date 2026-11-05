import { DropdownMenuLabel } from './ui/dropdown-menu'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'

// Name the import machine for remote pages: it chooses the browser inventory and receives permission prompts. Local imports need no notice.
export function BrowserCookieImportMachineNotice(): React.JSX.Element | null {
  const detectedBrowsersHost = useAppStore((s) => s.detectedBrowsersHost)
  if (!detectedBrowsersHost) {
    return null
  }
  const clientHosted = detectedBrowsersHost.machine === 'client'
  const hostLabel = detectedBrowsersHost.hostLabel
  return (
    <>
      <DropdownMenuLabel>
        {clientHosted
          ? translate(
              'auto.components.BrowserCookieImportMachineNotice.clientLabel',
              'Browsers on this device'
            )
          : translate(
              'auto.components.BrowserCookieImportMachineNotice.remoteLabel',
              'Browsers on {{value0}}',
              { value0: hostLabel }
            )}
      </DropdownMenuLabel>
      <p className="max-w-60 px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
        {clientHosted
          ? translate(
              'auto.components.BrowserCookieImportMachineNotice.clientNoteLocalStorage',
              'Imports read this device’s browsers. Cookies are stored locally.'
            )
          : translate(
              'auto.components.BrowserCookieImportMachineNotice.remoteNoteRemoteStorage',
              'Imports read browsers on {{value0}}. Cookies are stored on that machine, and a permission prompt may appear on its screen.',
              { value0: hostLabel }
            )}
      </p>
    </>
  )
}
