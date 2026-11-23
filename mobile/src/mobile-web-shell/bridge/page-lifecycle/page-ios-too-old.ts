import { translate } from '../../../i18n/mobile-i18n'
import { colors, spacing, typography } from '../../../theme/mobile-theme'

// app.json's ios.deploymentTarget, which the page build defines; verify holds every route to it.
const IOS_MINIMUM = String(process.env.ORCA_IOS_MINIMUM)

/** Lookbehind is what WebKit added in iOS 16.4; without it the routes cannot even parse. */
export function webKitRunsThePage(): boolean {
  try {
    return new RegExp('(?<=a)b').test('ab')
  } catch {
    return false
  }
}

export type IosTooOldCopy = { message: string; detail: string }

// iPhone and iPod WebViews name the version; an iPad's desktop-class one does not.
function iosVersion(userAgent: string): { major: number; minor: number; text: string } | null {
  const match = /\bOS (\d+)_(\d+)(?:_(\d+))?\b/.exec(userAgent)
  if (!match) {
    return null
  }
  const text = [match[1], match[2], match[3]].filter((part) => part !== undefined).join('.')
  return { major: Number(match[1]), minor: Number(match[2]), text }
}

export function iosTooOldCopy(userAgent: string): IosTooOldCopy {
  const version = iosVersion(userAgent)
  // Apple shipped iOS 15.8 only to devices that cannot run iOS 16.
  if (version && version.major === 15 && version.minor >= 8) {
    return {
      message: translate(
        'webShell.iosTooOld.cannotUpdate',
        'Orca needs iOS {{version}} or newer, which this device can’t install.',
        { version: IOS_MINIMUM }
      ),
      detail: translate('webShell.iosTooOld.deviceHas', 'This device has iOS {{version}}.', {
        version: version.text
      })
    }
  }
  return {
    message: translate(
      'webShell.iosTooOld.update',
      'Orca needs iOS {{version}} or newer. Update it in Settings > General > Software Update.',
      { version: IOS_MINIMUM }
    ),
    detail: version
      ? translate('webShell.iosTooOld.deviceHas', 'This device has iOS {{version}}.', {
          version: version.text
        })
      : translate(
          'webShell.iosTooOld.noUpdateOffered',
          'If no update is offered, Orca can’t run on this device.'
        )
  }
}

// The shell's failure screen, drawn in the page: no router can load to draw it in React.
export function renderIosTooOldPanel(container: HTMLElement, copy: IosTooOldCopy): void {
  const panel = document.createElement('div')
  panel.setAttribute('role', 'alert')
  panel.style.cssText =
    `flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `padding:0 ${String(spacing.lg)}px;background:${colors.bgBase};text-align:center;` +
    `font-family:system-ui,-apple-system,sans-serif`
  const message = document.createElement('div')
  message.style.cssText = `font-size:${String(typography.bodySize)}px;color:${colors.textPrimary};margin-bottom:${String(spacing.lg)}px`
  message.textContent = copy.message
  const detail = document.createElement('div')
  detail.style.cssText = `font-size:${String(typography.metaSize)}px;color:${colors.textSecondary}`
  detail.textContent = copy.detail
  panel.append(message, detail)
  container.replaceChildren(panel)
}
