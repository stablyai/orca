import { ActivityIndicator, View } from 'react-native'
import type { AccountsSnapshot } from './accounts-snapshot'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

export type ManagedDataProvider = 'opencode' | 'devin'

export function managedDataBusyId(provider: ManagedDataProvider, accountId: string | null): string {
  return `data:${provider}:${accountId ?? 'default'}`
}

// Selection only; profiles are added and removed on desktop.
export function ManagedDataAccountSection({
  provider,
  snapshot,
  busyAccountId,
  switchBlocked,
  onSelect
}: {
  provider: ManagedDataProvider
  snapshot: AccountsSnapshot
  busyAccountId: string | null
  switchBlocked: boolean
  onSelect: (provider: ManagedDataProvider, accountId: string | null) => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const state = snapshot[provider]
  if (!state || state.accounts.length === 0) {
    return null
  }
  const rows = [
    {
      id: null,
      title: t('accounts.screen.default', 'System default'),
      subtitle: t('accounts.screen.agentLogin', "Use the agent's own login")
    },
    ...state.accounts.map((account) => ({
      id: account.id,
      title: account.label,
      subtitle:
        account.integrations.filter((integration) => integration.trim() !== '').join(', ') ||
        undefined
    }))
  ]
  return (
    <View>
      <SectionHeader
        title={TUI_AGENT_DISPLAY_NAMES[provider]}
        icon={<MobileAgentIcon agentId={provider} size={14} />}
      />
      <ListGroup>
        {rows.map((row) => {
          const selected = state.activeAccountId === row.id
          return (
            <ListRow
              key={row.id ?? 'default'}
              title={row.title}
              subtitle={row.subtitle}
              accessory={
                busyAccountId === managedDataBusyId(provider, row.id) ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : undefined
              }
              selected={selected}
              onPress={switchBlocked || selected ? undefined : () => onSelect(provider, row.id)}
            />
          )
        })}
      </ListGroup>
    </View>
  )
}
