import { useCallback, useState, type ReactElement } from 'react'
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'
import { CursorIcon, MuseSparkIcon } from '../components/AgentIcons'

type SwitchOnlyProvider = {
  method: 'accounts.selectCursor' | 'accounts.selectMuseSpark'
  title: string
  Icon: (props: { size?: number }) => ReactElement
  accounts: { id: string; email: string }[]
  activeAccountId: string | null
  emptyText: string
}

type RpcClient = {
  sendRequest: (
    method: string,
    params: unknown
  ) => Promise<{ ok: true } | { ok: false; error: { message: string } }>
}

type Props = {
  client: RpcClient | null
  connected: boolean
  cursor: { accounts: { id: string; email: string }[]; activeAccountId: string | null }
  museSpark: { accounts: { id: string; email: string }[]; activeAccountId: string | null }
  onRefresh: () => Promise<void>
}

/**
 * Cursor + MuseSpark account switchers for the mobile accounts screen. These
 * providers have no usage windows, so they render switch-only rows through
 * their own RPCs instead of the usage-bar path used for Claude/Codex. Sections
 * with no accounts are hidden.
 */
export function SwitchOnlyProviderSections({
  client,
  connected,
  cursor,
  museSpark,
  onRefresh
}: Props): ReactElement | null {
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)

  const selectAccount = useCallback(
    async (method: SwitchOnlyProvider['method'], accountId: string) => {
      if (!client) {
        return
      }
      setBusyAccountId(accountId)
      try {
        const res = await client.sendRequest(method, { accountId })
        if (!res.ok) {
          Alert.alert('Could not switch account', res.error.message)
        } else {
          await onRefresh()
        }
      } catch (e) {
        Alert.alert('Could not switch account', e instanceof Error ? e.message : String(e))
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, onRefresh]
  )

  const providers: SwitchOnlyProvider[] = []
  if (cursor.accounts.length > 0) {
    providers.push({
      method: 'accounts.selectCursor',
      title: 'Cursor',
      Icon: CursorIcon,
      accounts: cursor.accounts,
      activeAccountId: cursor.activeAccountId,
      emptyText: 'No Cursor account detected on this host.'
    })
  }
  if (museSpark.accounts.length > 0) {
    providers.push({
      method: 'accounts.selectMuseSpark',
      title: 'MuseSpark',
      Icon: MuseSparkIcon,
      accounts: museSpark.accounts,
      activeAccountId: museSpark.activeAccountId,
      emptyText: 'No MuseSpark accounts yet.'
    })
  }
  if (providers.length === 0) {
    return null
  }

  return (
    <>
      {providers.map(({ method, title, Icon, accounts, activeAccountId }) => (
        <View style={styles.section} key={method}>
          <View style={styles.sectionHeader}>
            <Icon size={14} />
            <Text style={styles.sectionHeading}>{title}</Text>
          </View>
          <View style={styles.card}>
            {accounts.map((account, index) => {
              const isActive = activeAccountId === account.id
              return (
                <View key={account.id}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <Pressable
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    onPress={() => void selectAccount(method, account.id)}
                    disabled={busyAccountId !== null || !connected || isActive}
                  >
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {account.email}
                      </Text>
                    </View>
                    <View style={styles.rowTrailing}>
                      {isActive ? (
                        <Check size={16} color={colors.accentBlue} />
                      ) : busyAccountId === account.id ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : null}
                    </View>
                  </Pressable>
                </View>
              )
            })}
          </View>
        </View>
      ))}
    </>
  )
}
