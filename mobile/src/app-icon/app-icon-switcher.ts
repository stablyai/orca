import { APP_ICON_OPTIONS, DEFAULT_APP_ICON_ID, type AppIconId } from '../../../src/shared/app-icon'
import { nativeAppIcon } from './native-app-icon'

// Must match plugins/alternate-app-icons.js: the iOS icon set and Android launcher alias names.
// No separator because an Android alias name has to be a valid Java class name.
export function alternateIconNameFor(iconId: AppIconId): string | null {
  return iconId === DEFAULT_APP_ICON_ID
    ? null
    : `AppIcon${iconId.charAt(0).toUpperCase()}${iconId.slice(1)}`
}

export function appIconIdFromAlternateName(name: string | null): AppIconId {
  return (
    APP_ICON_OPTIONS.find(({ id }) => alternateIconNameFor(id) === name)?.id ?? DEFAULT_APP_ICON_ID
  )
}

export function hasNativeAppIconModule(): boolean {
  return nativeAppIcon !== null
}

// The OS persists the chosen icon, so it is the only source of truth; nothing is stored here.
export async function loadAppIcon(): Promise<{ supported: boolean; iconId: AppIconId }> {
  if (!nativeAppIcon || !(await nativeAppIcon.supportsAlternateIcons())) {
    return { supported: false, iconId: DEFAULT_APP_ICON_ID }
  }
  return {
    supported: true,
    iconId: appIconIdFromAlternateName(await nativeAppIcon.getAlternateIconName())
  }
}

export async function saveAppIcon(iconId: AppIconId): Promise<void> {
  if (!nativeAppIcon) {
    throw new Error('Changing the app icon is not supported on this device.')
  }
  await nativeAppIcon.setAlternateIconName(alternateIconNameFor(iconId))
}
