import { StyleSheet, View } from 'react-native'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import {
  getActiveProviderRateLimits,
  getUsageBarState,
  hasActiveProviderUsage,
  type AccountsSnapshot,
  type ProviderKey
} from '../components/AccountUsage'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { colors } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'

const PROVIDERS: readonly ProviderKey[] = ['claude', 'codex']
const PROVIDER_LABELS: Record<ProviderKey, string> = { claude: 'Claude', codex: 'Codex' }

/** Home's "Usage": one compact row per account; each opens that desktop's Accounts screen. */
export function MobileHomeAccountUsageCards(props: {
  items: { host: HostProfile; snapshot: AccountsSnapshot }[]
  onOpen: (hostId: string) => void
}) {
  if (props.items.length === 0) {
    return null
  }
  const showHost = props.items.length > 1
  const rows = props.items.flatMap(({ host, snapshot }) =>
    PROVIDERS.flatMap((provider) => {
      const providerSnapshot = provider === 'claude' ? snapshot.claude : snapshot.codex
      const limits = getActiveProviderRateLimits(snapshot, provider)
      if (providerSnapshot.accounts.length === 0 && !hasActiveProviderUsage(limits)) {
        return []
      }
      const active =
        providerSnapshot.accounts.find(
          (account) => account.id === providerSnapshot.activeAccountId
        ) ?? null
      return [
        <UsageRow
          key={`${host.id}:${provider}`}
          provider={provider}
          email={active?.email ?? 'System default'}
          hostName={showHost ? host.name : null}
          session={getUsageBarState(limits, 'session')}
          onPress={() => props.onOpen(host.id)}
        />
      ]
    })
  )
  if (rows.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title="Usage" />
      <ListGroup separatorInset={LIST_LEADING_INSET}>{rows}</ListGroup>
    </>
  )
}

type BarState = ReturnType<typeof getUsageBarState>

// Same consumption bands as UsageBar: green under 60, amber under 80, red from 80.
function meterColor(used: number): string {
  return used >= 80 ? colors.statusRed : used >= 60 ? colors.statusAmber : colors.statusGreen
}

/** One line per account: logo, provider, the 5-hour percent and a small meter, then a chevron. */
function UsageRow(props: {
  provider: ProviderKey
  email: string
  hostName: string | null
  session: BarState
  onPress: () => void
}) {
  const { session } = props
  const used =
    session.usedPercent == null || session.unavailable
      ? null
      : Math.max(0, Math.min(100, Math.round(session.usedPercent)))
  const value = session.loading ? '…' : used == null ? '—' : `${used}%`
  const label = [
    `${PROVIDER_LABELS[props.provider]} usage`,
    props.email,
    props.hostName ? `on ${props.hostName}` : null,
    used == null ? null : `${used}% of the 5-hour limit used`
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <ListRow
      title={PROVIDER_LABELS[props.provider]}
      subtitle={props.hostName ?? undefined}
      leading={
        props.provider === 'claude' ? (
          <ClaudeIcon size={20} />
        ) : (
          <OpenAIIcon size={20} color={colors.textPrimary} />
        )
      }
      value={value}
      accessory={
        <View style={styles.meter}>
          {used == null ? null : (
            <View
              style={[styles.meterFill, { width: `${used}%`, backgroundColor: meterColor(used) }]}
            />
          )}
        </View>
      }
      navigates
      onPress={props.onPress}
      accessibilityLabel={label}
    />
  )
}

const styles = StyleSheet.create({
  meter: {
    width: 56,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.fill,
    overflow: 'hidden',
    flexShrink: 0
  },
  meterFill: { height: '100%', borderRadius: 3 }
})
