import { Text } from 'react-native'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import { hostManualUpdateSteps } from '../../host-descriptors/host-manual-update-steps'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { useHostStatusGates } from '../../transport/connection/host-status-gates'

/** The host's Orca version, plus how to update a server that can't take a client-driven update. */
export function HostOrcaVersionSection({ hostId }: { hostId: string }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, state } = useHostClient(hostId)
  const { desktopAppVersion, hostCapabilities, hostUpdateSupport } = useHostStatusGates({
    hostId,
    client,
    connState: state
  })
  if (!desktopAppVersion) {
    return null
  }
  const updateSteps = hostManualUpdateSteps(hostUpdateSupport, hostCapabilities, t)
  return (
    <>
      <ListGroup style={styles.group}>
        <ListRow title={t('host.edit.orcaVersion', 'Orca version')} value={desktopAppVersion} />
      </ListGroup>
      {updateSteps ? <Text style={styles.steps}>{updateSteps}</Text> : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  group: {
    marginTop: spacing.lg
  },
  steps: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 16
  }
}))
