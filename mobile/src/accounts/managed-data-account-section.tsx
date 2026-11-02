import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AccountsSnapshot } from '../components/accounts-snapshot'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-accounts-screen-styles'

export type ManagedDataProvider = 'opencode' | 'devin'

const COPY = {
  opencode: { agentId: 'opencode', headingKey: 'accounts.screen.opencode', heading: 'OpenCode' },
  devin: { agentId: 'devin', headingKey: 'accounts.screen.devin', heading: 'Devin' }
} as const

export function managedDataBusyId(provider: ManagedDataProvider, accountId: string | null): string {
  return `data:${provider}:${accountId ?? 'default'}`
}

// Read-only aside from selection. Adding or removing profiles stays on the desktop host.
export function ManagedDataAccountSection({
  provider,
  snapshot,
  busyAccountId,
  disabled,
  onSelect
}: {
  provider: ManagedDataProvider
  snapshot: AccountsSnapshot
  busyAccountId: string | null
  disabled: boolean
  onSelect: (provider: ManagedDataProvider, accountId: string | null) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const state = snapshot[provider]
  if (!state || state.accounts.length === 0) {
    return null
  }
  const copy = COPY[provider]
  const rows = [
    {
      id: null as string | null,
      title: t('accounts.screen.default', 'System default'),
      subtitle: t('accounts.screen.agentLogin', "Use the agent's own login")
    },
    ...state.accounts.map((account) => ({
      id: account.id,
      title: account.label,
      subtitle: account.integrations.filter((integration) => integration.trim() !== '').join(', ')
    }))
  ]

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId={copy.agentId} size={14} />
        <Text style={styles.sectionHeading}>{t(copy.headingKey, copy.heading)}</Text>
      </View>
      <View style={styles.card}>
        {rows.map((row, index) => {
          const busyId = managedDataBusyId(provider, row.id)
          const active = state.activeAccountId === row.id
          return (
            <View key={row.id ?? 'default'}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => onSelect(provider, row.id)}
                disabled={disabled || active || busyAccountId !== null}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {row.title}
                  </Text>
                  {row.subtitle ? (
                    <Text style={styles.rowSubtitle} numberOfLines={2}>
                      {row.subtitle}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.rowTrailing}>
                  {active ? (
                    <Check size={16} color={colors.accentBlue} />
                  ) : busyAccountId === busyId ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : null}
                </View>
              </Pressable>
            </View>
          )
        })}
      </View>
    </View>
  )
}
