import { useState } from 'react'
import { browserSessionProfileLabel } from '../../../../src/shared/browser/profiles/browser-session-profile-label'
import { PickerModal } from '../../components/sheets/PickerModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  useMobileBrowserProfiles,
  type MobileBrowserProfile
} from '../../browser/tab-navigation/use-mobile-browser-profiles'

// Sending no profile lets the host apply desktop's rule (repo, then workspace, then host default).
const WORKSPACE_DEFAULT = ''

export type MobileNewBrowserProfileChoice = ReturnType<typeof useMobileNewBrowserProfile>

/** The host's profiles while a sheet that names them is open, and the profile a new browser tab opens in. */
export function useMobileNewBrowserProfile(client: RpcClient | null, sheetOpen: boolean) {
  const [profileId, setProfileId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const profiles = useMobileBrowserProfiles(client, sheetOpen || pickerOpen)
  // A profile deleted on the host since it was picked falls back to the workspace default.
  const liveProfileId = profiles.some((profile) => profile.id === profileId) ? profileId : null
  return { profiles, profileId: liveProfileId, setProfileId, pickerOpen, setPickerOpen }
}

export function useMobileBrowserProfileLabel(
  profiles: readonly MobileBrowserProfile[]
): (profileId: string) => string {
  const t = useMobileTranslation()
  return (profileId) =>
    browserSessionProfileLabel(
      profiles.find((profile) => profile.id === profileId)?.label,
      profileId,
      t('session.browserProfile.default', 'Default')
    )
}

export function MobileBrowserProfilePicker({
  choice,
  onAfterClose
}: {
  choice: MobileNewBrowserProfileChoice
  onAfterClose: () => void
}) {
  const t = useMobileTranslation()
  const labelFor = useMobileBrowserProfileLabel(choice.profiles)
  return (
    <PickerModal
      visible={choice.pickerOpen}
      title={t('session.browserProfile.title', 'Profile')}
      options={[
        {
          value: WORKSPACE_DEFAULT,
          label: t('session.browserProfile.workspaceDefault', 'Workspace default')
        },
        ...choice.profiles.map((profile) => ({ value: profile.id, label: labelFor(profile.id) }))
      ]}
      selected={choice.profileId ?? WORKSPACE_DEFAULT}
      onSelect={(value) => {
        choice.setProfileId(value === WORKSPACE_DEFAULT ? null : value)
        choice.setPickerOpen(false)
      }}
      onClose={() => choice.setPickerOpen(false)}
      onAfterClose={onAfterClose}
    />
  )
}
