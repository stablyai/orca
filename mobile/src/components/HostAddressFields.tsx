import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { HostEndpointEditResolution } from '../transport/host-endpoint-edit'

type Props = {
  address: string
  alternateAddress: string
  alternateEndpoint: string | null
  alternateEndpointEdit: HostEndpointEditResolution | null
  canSave: boolean
  duplicateAddresses: boolean
  endpointEdit: HostEndpointEditResolution
  onAddressChange: (value: string) => void
  onAlternateAddressChange: (value: string) => void
  onSubmit: () => void
}

export function HostAddressFields(props: Props) {
  return (
    <View style={styles.fields}>
      <Text style={styles.label}>Address</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Address"
        value={props.address}
        onChangeText={props.onAddressChange}
        placeholder="192.168.1.10:6768"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        returnKeyType="next"
      />
      <Text style={styles.hint}>
        Accepts IP, host:port, or ws:// / wss://. Missing port uses the current port or 6768.
      </Text>
      {props.endpointEdit.kind !== 'invalid' ? (
        <Text style={styles.preview} numberOfLines={2}>
          Primary: {props.endpointEdit.endpoint}
        </Text>
      ) : props.address.trim() ? (
        <Text style={styles.previewError}>{props.endpointEdit.error}</Text>
      ) : null}

      <Text style={styles.label}>Alternate address</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Alternate address"
        value={props.alternateAddress}
        onChangeText={props.onAlternateAddressChange}
        placeholder="100.64.0.10:6768"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={() => props.canSave && props.onSubmit()}
      />
      <Text style={styles.hint}>Optional. Use a different LAN or Tailscale address.</Text>
      {props.alternateEndpointEdit?.kind === 'invalid' ? (
        <Text style={styles.previewError}>{props.alternateEndpointEdit.error}</Text>
      ) : props.duplicateAddresses ? (
        <Text style={styles.previewError}>Use a different alternate address.</Text>
      ) : props.alternateEndpoint ? (
        <Text style={styles.preview} numberOfLines={2}>
          Alternate: {props.alternateEndpoint}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fields: { gap: spacing.sm },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  input: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10
  },
  hint: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 16 },
  preview: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : typography.monoFamily
  },
  previewError: { marginTop: spacing.sm, color: colors.statusRed, fontSize: typography.bodySize }
})
