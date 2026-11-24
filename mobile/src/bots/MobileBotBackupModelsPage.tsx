// Bot backup models settings page on mobile: active failover banner, order, mode, and add picker.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react-native'
import { isBotAgent } from '../../../src/shared/bot-types'
import {
  BOT_BACKUP_MODEL_LIMIT,
  addBotBackupModel,
  botModelTargetKey,
  removeBotBackupModel,
  reorderBotBackupModels,
  type BotBackupModelEntry,
  type BotBackupModels,
  type BotBackupStatusResult
} from '../../../src/shared/bots/bot-backup-models'
import { formatUsageLimitResetClock } from '../../../src/shared/agent-session/failures/agent-session-usage-limit'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SwitchRow } from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors, feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botBackupReturn, botBackupStatusRead, type SheetBot } from './bot-sheet-operations'
import { botAgentLabel, botSaveErrorMessage } from './mobile-bot-sheet-copy'
import { MobileBotActiveBackupBanner } from './MobileBotActiveBackupBanner'
import { MobileBotBackupModelPicker } from './MobileBotBackupModelPicker'

function formatTarget(agent: string, model?: string, effort?: string): string {
  const name = botAgentLabel(agent)
  const base = model ? `${name} · ${model}` : name
  return effort ? `${base} (${effort})` : base
}

function formatAvailabilityLine(
  t: ReturnType<typeof useMobileTranslation>,
  state: string | undefined,
  resetsAt?: number
): string {
  if (state === 'at-limit') {
    return resetsAt !== undefined
      ? t('bots.settings.backupModelsAtLimitReset', 'At limit · resets {{time}}', {
          time: formatUsageLimitResetClock(resetsAt)
        })
      : t('bots.settings.backupModelsAtLimit', 'At usage limit')
  }
  return state === 'unavailable'
    ? t('bots.settings.backupModelsUnavailable', 'Unavailable')
    : t('bots.settings.backupModelsReady', 'Ready')
}

function RowActionButton(props: {
  label: string
  disabled: boolean
  onPress: () => void
  icon: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.iconBtn, props.disabled && styles.disabled]}
    >
      {props.icon}
    </Pressable>
  )
}

export function MobileBotBackupModelsPage(props: {
  bot: SheetBot
  client: RpcClient | null
  online: boolean
  disabled: boolean
  hostName: string
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  onSave: (backupModels: BotBackupModels | null) => Promise<boolean>
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const { bot, client, online } = props
  const [statusState, setStatusState] = useState<{
    botId: string
    client: RpcClient
    data: BotBackupStatusResult
  } | null>(null)
  const [picking, setPicking] = useState(false)
  const [returning, setReturning] = useState(false)
  const refreshGenRef = useRef(0)

  const status =
    statusState && statusState.botId === bot.id && statusState.client === client
      ? statusState.data
      : null

  useBackClaim(
    picking
      ? () => {
          setPicking(false)
          return true
        }
      : null
  )

  const refreshStatus = useCallback(async () => {
    if (!client || !online) {
      return
    }
    const gen = ++refreshGenRef.current
    try {
      const next = botBackupStatusRead.interpret(
        await botBackupStatusRead.request(client, { botId: bot.id }, { failWhenDisconnected: true })
      )
      if (gen === refreshGenRef.current) {
        setStatusState({ botId: bot.id, client, data: next })
      }
    } catch {
      // Keep the bot snapshot's backup list visible when status read fails.
    }
  }, [bot.id, client, online])

  useEffect(() => {
    void refreshStatus()
    return () => {
      refreshGenRef.current += 1
    }
  }, [refreshStatus, bot.backupModels, bot.activeBackup])

  const primary = useMemo<BotBackupModelEntry | null>(() => {
    if (!isBotAgent(bot.agent)) {
      return null
    }
    return {
      agent: bot.agent,
      ...(bot.launch?.model ? { model: bot.launch.model } : {}),
      ...(bot.launch?.options ? { options: bot.launch.options } : {})
    }
  }, [bot.agent, bot.launch])

  const order = bot.backupModels?.order ?? []
  const automatic = bot.backupModels?.automatic ?? true
  const activeBackup = status?.activeBackup ?? bot.activeBackup ?? null

  const excludedKeys = useMemo(() => {
    const keys = new Set<string>()
    if (primary) {
      keys.add(botModelTargetKey(primary))
    }
    for (const entry of order) {
      keys.add(botModelTargetKey(entry))
    }
    return keys
  }, [primary, order])

  const statusByKey = useMemo(() => {
    const map = new Map<string, { state: string; resetsAt?: number }>()
    for (const row of status?.entries ?? []) {
      map.set(botModelTargetKey(row.entry), { state: row.state, resetsAt: row.resetsAt })
    }
    return map
  }, [status])

  const handleReturnNow = async () => {
    if (!client || returning) {
      return
    }
    setReturning(true)
    try {
      botBackupReturn.interpret(
        await botBackupReturn.request(client, { botId: bot.id }, { failWhenDisconnected: true })
      )
      await refreshStatus()
    } catch (error) {
      props.showToast(botSaveErrorMessage(error, props.hostName), 1800)
    } finally {
      setReturning(false)
    }
  }

  if (picking) {
    return (
      <MobileBotBackupModelPicker
        options={status?.availableOptions ?? []}
        excludedKeys={excludedKeys}
        disabled={props.disabled}
        banner={props.banner}
        onBack={{
          label: t('bots.settings.backupModels', 'Backup models'),
          onPress: () => setPicking(false)
        }}
        onPick={(entry) => {
          setPicking(false)
          if (!primary) {
            return
          }
          const next = addBotBackupModel(bot.backupModels, entry, primary)
          void props.onSave(next ?? null)
        }}
      />
    )
  }

  return (
    <>
      <SheetHeader title={t('bots.settings.backupModels', 'Backup models')} onBack={props.onBack} />
      {props.banner}
      <SettingsNote>
        {t(
          'bots.settings.backupModelsDetail',
          'When this bot hits its usage limit, Orca switches to the first available backup and returns to the primary model once it resets.'
        )}
      </SettingsNote>

      {activeBackup ? (
        <MobileBotActiveBackupBanner
          activeBackup={activeBackup}
          targetLabel={formatTarget(
            activeBackup.target.agent,
            activeBackup.target.model,
            activeBackup.target.options?.effort
          )}
          primaryLabel={formatTarget(bot.agent, bot.launch?.model ?? activeBackup.primaryModel)}
          disabled={props.disabled}
          returning={returning}
          onReturnNow={() => void handleReturnNow()}
        />
      ) : null}

      <SettingsSection title={t('bots.settings.backupModelsPrimary', 'Primary')}>
        <ListRow
          title={formatTarget(bot.agent, bot.launch?.model)}
          subtitle={formatAvailabilityLine(t, status?.primary.state, status?.primary.resetsAt)}
        />
      </SettingsSection>

      <SettingsSection
        title={t('bots.settings.backupModelsFallbackOrder', 'Fallback order')}
        footer={
          order.length > 0
            ? t(
                'bots.settings.backupModelsCount',
                '{{count}} of {{max}} backup models configured.',
                { count: order.length, max: BOT_BACKUP_MODEL_LIMIT }
              )
            : undefined
        }
      >
        {order.length === 0 ? (
          <ListRow
            title={t('bots.settings.backupModelsEmpty', 'No backup models configured')}
            subtitle={t(
              'bots.settings.backupModelsEmptyHint',
              'Add a model to keep this bot working if its primary hits a usage limit.'
            )}
          />
        ) : (
          order.map((entry, index) => {
            const key = botModelTargetKey(entry)
            const entryStatus = statusByKey.get(key)
            const isActive = activeBackup !== null && botModelTargetKey(activeBackup.target) === key
            const statusLine = isActive
              ? t('bots.settings.backupModelsActiveTag', 'Active now')
              : formatAvailabilityLine(t, entryStatus?.state, entryStatus?.resetsAt)
            return (
              <ListRow
                key={key}
                title={`${index + 1}. ${formatTarget(entry.agent, entry.model, entry.options?.effort)}`}
                subtitle={statusLine}
                accessory={
                  <View style={styles.rowActions}>
                    <RowActionButton
                      label={t('bots.settings.backupModelsMoveUp', 'Move up')}
                      disabled={props.disabled || index === 0}
                      onPress={() => {
                        const next = reorderBotBackupModels(bot.backupModels, index, index - 1)
                        if (next) {
                          void props.onSave(next)
                        }
                      }}
                      icon={<ArrowUp size={15} color={colors.textSecondary} />}
                    />
                    <RowActionButton
                      label={t('bots.settings.backupModelsMoveDown', 'Move down')}
                      disabled={props.disabled || index === order.length - 1}
                      onPress={() => {
                        const next = reorderBotBackupModels(bot.backupModels, index, index + 1)
                        if (next) {
                          void props.onSave(next)
                        }
                      }}
                      icon={<ArrowDown size={15} color={colors.textSecondary} />}
                    />
                    <RowActionButton
                      label={t('bots.settings.backupModelsRemove', 'Remove')}
                      disabled={props.disabled}
                      onPress={() =>
                        void props.onSave(removeBotBackupModel(bot.backupModels, index) ?? null)
                      }
                      icon={<Trash2 size={15} color={colors.textSecondary} />}
                    />
                  </View>
                }
              />
            )
          })
        )}
        {order.length < BOT_BACKUP_MODEL_LIMIT ? (
          <ListRow
            leading={<Plus size={16} color={colors.textPrimary} />}
            title={t('bots.settings.backupModelsAdd', 'Add backup model')}
            disabled={props.disabled}
            onPress={() => setPicking(true)}
            accessibilityRole="button"
          />
        ) : null}
      </SettingsSection>

      {order.length > 0 ? (
        <SettingsSection>
          <SwitchRow
            label={t('bots.settings.backupModelsAskBefore', 'Ask before switching')}
            detail={t(
              'bots.settings.backupModelsAskBeforeDetail',
              'Wait for your confirmation in chat instead of switching automatically.'
            )}
            value={!automatic}
            disabled={props.disabled}
            onChange={(ask) => {
              if (!bot.backupModels) {
                return
              }
              void props.onSave({ ...bot.backupModels, automatic: !ask })
            }}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  iconBtn: {
    padding: 6
  },
  disabled: {
    opacity: feedback.disabledOpacity
  }
}))
