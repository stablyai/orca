import { Pressable, Text, View } from 'react-native'
import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import {
  ORCA_CLOUD_IMAGE_AGENTS,
  type OrcaCloudImageAgent
} from '../../../src/shared/hosted-sandbox/orca-cloud-image-agents'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** Product names, from the app's one agent-name table. */
export function cloudAgentLabel(agent: string): string {
  return formatAgentTypeLabel(agent)
}

export function CloudAgentPicker(props: {
  value: OrcaCloudImageAgent
  onChange: (agent: OrcaCloudImageAgent) => void
  disabled?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View
      style={styles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('cloud.agent.label', 'Agent')}
    >
      {/* Only what the image ships: the VM does not exist yet, so nothing else could start. */}
      {ORCA_CLOUD_IMAGE_AGENTS.map((id) => {
        const label = cloudAgentLabel(id)
        const checked = props.value === id
        return (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ checked, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(id)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => [
              styles.chip,
              checked && styles.chipSelected,
              props.disabled && styles.disabled,
              pressed && styles.pressed
            ]}
          >
            <MobileAgentIcon agentId={id} size={15} />
            <Text style={[styles.label, checked && styles.labelSelected]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  chipSelected: { borderColor: colors.textPrimary },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  label: { fontSize: 14, color: colors.textSecondary },
  labelSelected: { color: colors.textPrimary, fontWeight: '600' }
}))
