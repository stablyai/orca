import type { ReactNode } from 'react'
import { MobileSettingsFrame, MobileSettingsSection } from './mobile-settings-menu'
import { mobileSettingsMenuGroups } from './mobile-settings-menu-items'

export default function SettingsMenuScreen({
  push,
  onBack,
  openExternal,
  notice,
  appUpdate
}: {
  push: (route: string) => void
  onBack?: () => void
  openExternal: (url: string) => Promise<unknown>
  /** A warning that needs the user first, shown above every group when present. */
  notice?: ReactNode
  /** Version and update rows, under the About group. */
  appUpdate?: ReactNode
}) {
  const groups = mobileSettingsMenuGroups(push, (url) => void openExternal(url))
  return (
    <MobileSettingsFrame onBack={onBack}>
      {notice}
      <MobileSettingsSection first {...groups.session} />
      <MobileSettingsSection {...groups.alerts} />
      <MobileSettingsSection {...groups.help} />
      <MobileSettingsSection {...groups.about} footer={appUpdate} />
    </MobileSettingsFrame>
  )
}
