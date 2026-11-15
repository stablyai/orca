import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '../../lib/keyboard/shortcut-platform'

type UpdateCheckClickEvent = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function isMacShortcutPlatform(): boolean {
  return getShortcutPlatform() === 'darwin'
}

export function getUpdateCheckHint(isMac = isMacShortcutPlatform()): string {
  const releaseHints = translate(
    'auto.lib.updateCheckClickOptions.releaseHint',
    '{{rcKey}}+click checks the latest RC; {{perfKey}}+click checks the latest perf build.',
    { rcKey: isMac ? '⇧' : 'Shift', perfKey: isMac ? '⌘' : 'Ctrl' }
  )
  return isMac
    ? `${releaseHints} ${translate(
        'auto.lib.updateCheckClickOptions.localMacBuildHint',
        '⌥+click chooses a local macOS build.'
      )}`
    : releaseHints
}

export function getUpdateCheckClickOptions(
  event: UpdateCheckClickEvent,
  isMac = isMacShortcutPlatform()
): UpdateCheckOptions {
  if (isMac && event.altKey) {
    return { localBuild: true }
  }
  return {
    includePrerelease: event.shiftKey,
    includePerfPrerelease: isMac ? event.metaKey : event.ctrlKey
  }
}
