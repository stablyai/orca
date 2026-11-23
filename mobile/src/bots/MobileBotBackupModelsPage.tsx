// Bot backup models settings page on mobile: active failover banner, order, mode, and add picker.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react-native'
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
import { colors, feedback, radius, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botBackupReturn, botBackupStatusRead, type SheetBot } from './bot-sheet-operations'
import { botAgentLabel, botSaveErrorMessage } from './mobile-bot-sheet-copy'
import { MobileBotBackupModelPicker } from './MobileBotBackupModelPicker'

function formatTarget(agent: string, model?: string, effort?: string): string {
  const name = botAgentLabel(agent)
  const base = model ? `${name} · ${model}` : name
  return effort ? `${base} (${effort})` : base
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
  const [status, setStatus] = useState<BotBackupStatusResult | null>(null)
  const [picking, setPicking] = useState(false)
  const [returning, setReturning] = useState(false)

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
    try {
      const next = botBackupStatusRead.interpret(
        await botBackupStatusRead.request(client, { botId: bot.id }, { failWhenDisconnected: true })
      )
      setStatus(next)
    } catch {
      // Keep the bot snapshot's backup list visible when status read fails.
    }
  }, [bot.id, client, online])

  useEffect(() => {
    void refreshStatus()
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
        <SettingsSection>
          <View style={styles.activeBanner}>
            <View style={styles.activeText}>
              <Text style={styles.activeTitle}>
                {t('bots.settings.backupModelsActiveBanner', 'Running on backup · {{target}}', {
                  target: formatTarget(
                    activeBackup.target.agent,
                    activeBackup.target.model,
                    activeBackup.target.options?.effort
                  )
                })}
              </Text>
              <Text style={styles.activeSub}>
                {activeBackup.primaryResetsAt !== undefined
                  ? t(
                      'bots.settings.backupModelsActiveReset',
                      'Returns to {{primary}} after {{time}}.',
                      {
                        primary: formatTarget(
                          bot.agent,
                          bot.launch?.model ?? activeBackup.primaryModel
                        ),
                        time: formatUsageLimitResetClock(activeBackup.primaryResetsAt)
                      }
                    )
                  : t(
                      'bots.settings.backupModelsActiveReturn',
                      'Returns to {{primary}} when ready.',
                      {
                        primary: formatTarget(
                          bot.agent,
                          bot.launch?.model ?? activeBackup.primaryModel
                        )
                      }
                    )}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={props.disabled || returning}
              onPress={() => void handleReturnNow()}
              style={({ pressed }) => [
                styles.returnBtn,
                (props.disabled || returning) && styles.disabled,
                pressed && styles.pressed
              ]}
            >
              <RotateCcw size={14} color={colors.textPrimary} />
              <Text style={styles.returnLabel}>
                {t('bots.settings.backupModelsReturnNow', 'Return now')}
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}

      <SettingsSection title={t('bots.settings.backupModelsPrimary', 'Primary')}>
        <ListRow
          title={formatTarget(bot.agent, bot.launch?.model)}
          subtitle={
            status?.primary.state === 'at-limit'
              ? status.primary.resetsAt !== undefined
                ? t('bots.settings.backupModelsAtLimitReset', 'At limit · resets {{time}}', {
                    time: formatUsageLimitResetClock(status.primary.resetsAt)
                  })
                : t('bots.settings.backupModelsAtLimit', 'At usage limit')
              : status?.primary.state === 'unavailable'
                ? t('bots.settings.backupModelsUnavailable', 'Unavailable')
                : t('bots.settings.backupModelsReady', 'Ready')
          }
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
              : entryStatus?.state === 'at-limit'
                ? entryStatus.resetsAt !== undefined
                  ? t('bots.settings.backupModelsAtLimitReset', 'At limit · resets {{time}}', {
                      time: formatUsageLimitResetClock(entryStatus.resetsAt)
                    })
                  : t('bots.settings.backupModelsAtLimit', 'At usage limit')
                : entryStatus?.state === 'unavailable'
                  ? t('bots.settings.backupModelsUnavailable', 'Unavailable')
                  : t('bots.settings.backupModelsReady', 'Ready')
            return (
              <ListRow
                key={key}
                title={`${index + 1}. ${formatTarget(entry.agent, entry.model, entry.options?.effort)}`}
                subtitle={statusLine}
                trailing={
                  <View style={styles.rowActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('bots.settings.backupModelsMoveUp', 'Move up')}
                      disabled={props.disabled || index === 0}
                      onPress={() => {
                        const next = reorderBotBackupModels(bot.backupModels, index, index - 1)
                        if (next) {
                          void props.onSave(next)
                        }
                      }}
                      style={[styles.iconBtn, (props.disabled || index === 0) && styles.disabled]}
                    >
                      <ArrowUp size={15} color={colors.textSecondary} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('bots.settings.backupModelsMoveDown', 'Move down')}
                      disabled={props.disabled || index === order.length - 1}
                      onPress={() => {
                        const next = reorderBotBackupModels(bot.backupModels, index, index + 1)
                        if (next) {
                          void props.onSave(next)
                        }
                      }}
                      style={[
                        styles.iconBtn,
                        (props.disabled || index === order.length - 1) && styles.disabled
                      ]}
                    >
                      <ArrowDown size={15} color={colors.textSecondary} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('bots.settings.backupModelsRemove', 'Remove')}
                      disabled={props.disabled}
                      onPress={() => {
                        const next = removeBotBackupModel(bot.backupModels, index)
                        void props.onSave(next ?? null)
                      }}
                      style={[styles.iconBtn, props.disabled && styles.disabled]}
                    >
                      <Trash2 size={15} color={colors.textSecondary} />
                    </Pressable>
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
  activeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  activeText: {
    flex: 1,
    gap: 2
  },
  activeTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  activeSub: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  returnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6
  },
  returnLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
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
  },
  pressed: {
    opacity: 0.7
  }
}))
