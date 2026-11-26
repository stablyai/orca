import { useHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { ListRow } from '../../components/list/ListGroup'
import { hostManualUpdateSteps } from '../../host-descriptors/host-manual-update-steps'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'

/** The host's Orca version, plus how to update a server that can't take a client-driven update. */
export function HostOrcaVersionSection() {
  const t = useMobileTranslation()
  // The host route already read status; reusing its gates keeps the last version across a drop.
  const { desktopAppVersion, hostCapabilities, hostUpdateSupport } = useHostProtocolGates()
  if (!desktopAppVersion) {
    return null
  }
  const updateSteps = hostManualUpdateSteps(hostUpdateSupport, hostCapabilities, t)
  return (
    <SettingsSection footer={updateSteps ?? undefined}>
      <ListRow
        key="version"
        title={t('host.edit.orcaVersion', 'Orca version')}
        value={desktopAppVersion}
      />
    </SettingsSection>
  )
}
