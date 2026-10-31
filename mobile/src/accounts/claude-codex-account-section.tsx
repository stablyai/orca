import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import { UsageBar } from '../components/AccountUsage'
import {
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  type AccountsSnapshot,
  type ProviderKey
} from '../components/account-usage-state'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from '../components/codex-reset-credit'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-accounts-screen-styles'

export function ClaudeCodexAccountSections({
  snapshot,
  now,
  busyAccountId,
  resettingCodex,
  connected,
  codexResetSupported,
  resetScope,
  resetScopeLabel,
  onSelect,
  onConfirmReset
}: {
  snapshot: AccountsSnapshot
  now: number
  busyAccountId: string | null
  resettingCodex: boolean
  connected: boolean
  codexResetSupported: boolean
  resetScope: CodexResetCreditExpectedScope | null
  resetScopeLabel: string | null
  onSelect: (provider: ProviderKey, accountId: string | null) => void
  onConfirmReset: () => void
}) {
  return (
    <>
      <ClaudeCodexAccountSection
        provider="claude"
        title="Claude"
        snapshot={snapshot}
        now={now}
        busyAccountId={busyAccountId}
        resettingCodex={resettingCodex}
        connected={connected}
        codexResetSupported={codexResetSupported}
        resetScope={resetScope}
        resetScopeLabel={resetScopeLabel}
        onSelect={onSelect}
        onConfirmReset={onConfirmReset}
      />
      <ClaudeCodexAccountSection
        provider="codex"
        title="Codex"
        snapshot={snapshot}
        now={now}
        busyAccountId={busyAccountId}
        resettingCodex={resettingCodex}
        connected={connected}
        codexResetSupported={codexResetSupported}
        resetScope={resetScope}
        resetScopeLabel={resetScopeLabel}
        onSelect={onSelect}
        onConfirmReset={onConfirmReset}
      />
    </>
  )
}

function ClaudeCodexAccountSection({
  provider,
  title,
  snapshot,
  now,
  busyAccountId,
  resettingCodex,
  connected,
  codexResetSupported,
  resetScope,
  resetScopeLabel,
  onSelect,
  onConfirmReset
}: {
  provider: ProviderKey
  title: string
  snapshot: AccountsSnapshot
  now: number
  busyAccountId: string | null
  resettingCodex: boolean
  connected: boolean
  codexResetSupported: boolean
  resetScope: CodexResetCreditExpectedScope | null
  resetScopeLabel: string | null
  onSelect: (provider: ProviderKey, accountId: string | null) => void
  onConfirmReset: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const state = provider === 'claude' ? snapshot.claude : snapshot.codex
  const activeAccountId =
    provider === 'codex' && snapshot.codex.activeAccountIdsByRuntime
      ? getActiveCodexAccountIdForRateLimitTarget(snapshot)
      : state.activeAccountId
  const activeUsage = getActiveProviderRateLimits(snapshot, provider)
  const activeSessionBar = getUsageBarState(activeUsage, 'session')
  const activeWeeklyBar = getUsageBarState(activeUsage, 'weekly')
  const resetCredit = provider === 'codex' ? getCodexResetCreditSummary(activeUsage, now) : null
  const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
  const disabled = busyAccountId !== null || resettingCodex || !connected
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Icon size={14} />
        <Text style={styles.sectionHeading}>{title}</Text>
      </View>
      <View style={styles.card}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => onSelect(provider, null)}
          disabled={disabled}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>{t('accounts.screen.default', 'System default')}</Text>
            <Text style={styles.rowSubtitle}>
              {t('accounts.screen.agentLogin', "Use the agent's own login")}
            </Text>
            {/* Show system-default login usage for users without managed accounts. */}
            {activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
              <View style={styles.usageRow}>
                <UsageBar
                  label={t('accounts.screen.sessionWindow', '5h')}
                  usedPercent={activeSessionBar.usedPercent}
                  unavailable={activeSessionBar.unavailable}
                  loading={activeSessionBar.loading}
                  resetText={getWindowResetLabel(activeUsage, 'session', now)}
                />
                <UsageBar
                  label={t('accounts.screen.weeklyWindow', '7d')}
                  usedPercent={activeWeeklyBar.usedPercent}
                  unavailable={activeWeeklyBar.unavailable}
                  loading={activeWeeklyBar.loading}
                  resetText={getWindowResetLabel(activeUsage, 'weekly', now)}
                />
              </View>
            ) : null}
          </View>
          <View style={styles.rowTrailing}>
            {activeAccountId === null ? (
              <Check size={16} color={colors.accentBlue} />
            ) : busyAccountId === `${provider}:default` ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
          </View>
        </Pressable>

        {state.accounts.map((account) => {
          const isActive = activeAccountId === account.id
          const inactiveEntry = !isActive
            ? getInactiveProviderUsage(snapshot, provider, account.id)
            : null
          const usage = isActive ? activeUsage : (inactiveEntry?.rateLimits ?? null)
          const isFetching =
            (isActive && usage?.status === 'fetching') ||
            (!isActive && inactiveEntry?.isFetching === true)
          const sessionBar = getUsageBarState(usage, 'session', isFetching)
          const weeklyBar = getUsageBarState(usage, 'weekly', isFetching)
          return (
            <View key={account.id}>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => onSelect(provider, account.id)}
                disabled={disabled || isActive}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {account.email}
                  </Text>
                  <View style={styles.usageRow}>
                    <UsageBar
                      label={t('accounts.screen.sessionWindow', '5h')}
                      usedPercent={sessionBar.usedPercent}
                      unavailable={sessionBar.unavailable}
                      loading={sessionBar.loading}
                      resetText={getWindowResetLabel(usage, 'session', now)}
                    />
                    <UsageBar
                      label={t('accounts.screen.weeklyWindow', '7d')}
                      usedPercent={weeklyBar.usedPercent}
                      unavailable={weeklyBar.unavailable}
                      loading={weeklyBar.loading}
                      resetText={getWindowResetLabel(usage, 'weekly', now)}
                    />
                  </View>
                  {usage?.error ? (
                    <Text style={styles.errorText} numberOfLines={1}>
                      {usage.error}
                    </Text>
                  ) : null}
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
        {resetCredit && codexResetSupported && resetScope && connected ? (
          <CodexResetCreditAction
            summary={resetCredit}
            scopeLabel={resetScopeLabel}
            busy={resettingCodex}
            disabled={disabled}
            onPress={onConfirmReset}
          />
        ) : null}
      </View>
    </View>
  )
}
