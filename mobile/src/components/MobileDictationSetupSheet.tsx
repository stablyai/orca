import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check, Download } from 'lucide-react-native'
import { BottomDrawer } from './BottomDrawer'
import { MobileSwitch } from './MobileSwitch'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  cloudModelNeedsKey,
  dictationModelRowAction,
  downloadDictationModel,
  fetchDictationSetup,
  isModelInFlight,
  setDictationConfig,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'

const POLL_INTERVAL_MS = 1500

type Props = {
  visible: boolean
  client: RpcClient | null
  onClose: () => void
  // Called after the user reaches a ready+enabled state, so the caller can retry.
  onReady?: () => void
}

type SetupError = { message: string } | { kind: 'load' | 'download' | 'select' | 'update' }

function setupErrorMessage(error: SetupError, t: Translate): string {
  if ('message' in error) {
    return error.message
  }
  switch (error.kind) {
    case 'load':
      return t('components.dictationSetupSheet.loadFailed', 'Failed to load')
    case 'download':
      return t('components.dictationSetupSheet.downloadFailed', 'Download failed')
    case 'select':
      return t('components.dictationSetupSheet.selectFailed', 'Could not select model')
    case 'update':
      return t('components.dictationSetupSheet.updateFailed', 'Could not update')
  }
}

function formatSize(bytes: number | null | undefined, t: Translate): string {
  if (!bytes) {
    return ''
  }
  return t('components.dictationSetupSheet.modelSize', '{{size}} MB', {
    size: Math.round(bytes / 1_000_000).toLocaleString(getUiIntlLocale())
  })
}

function modelMetadata(model: MobileSpeechModel, t: Translate): string {
  const details = model.provider === 'openai' ? 'OpenAI API' : formatSize(model.sizeBytes, t)
  if (isModelInFlight(model) && model.progress != null) {
    return t('components.dictationSetupSheet.modelProgress', '{{details}} · {{progress}}%', {
      details,
      progress: Math.round(model.progress * 100).toLocaleString(getUiIntlLocale())
    })
  }
  return model.status === 'extracting'
    ? t('components.dictationSetupSheet.modelExtracting', '{{details}} · extracting…', { details })
    : details
}

// Configure paired computer’s dictation/model from phone; poll while download is in flight.
export function MobileDictationSetupSheet({ visible, client, onClose, onReady }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [error, setError] = useState<SetupError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!client) {
      return false
    }
    try {
      const next = await fetchDictationSetup(client)
      setSetup(next)
      setError(null)
      return next.models.some(isModelInFlight)
    } catch (err) {
      setError(err instanceof Error ? { message: err.message } : { kind: 'load' })
      return undefined
    }
  }, [client])

  const polling = setup?.models.some(isModelInFlight) ?? false
  const refreshSetup = useDictationSetupPoller({
    visible: visible && client !== null,
    polling,
    refresh,
    intervalMs: POLL_INTERVAL_MS
  })

  useEffect(() => {
    if (visible) {
      setError(null)
    }
  }, [visible])

  const handleDownload = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusy(model.id)
      setError(null)
      try {
        await downloadDictationModel(client, model.id)
        await refreshSetup()
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? { message: err.message } : { kind: 'download' })
      } finally {
        setBusy(null)
      }
    },
    [client, refreshSetup]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusy(model.id)
      setError(null)
      try {
        const next = await setDictationConfig(client, { enabled: true, modelId: model.id })
        setSetup(next)
        triggerSuccess()
        onReady?.()
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? { message: err.message } : { kind: 'select' })
      } finally {
        setBusy(null)
      }
    },
    [client, onReady]
  )

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!client) {
        return
      }
      setError(null)
      try {
        setSetup(await setDictationConfig(client, { enabled }))
      } catch (err) {
        setError(err instanceof Error ? { message: err.message } : { kind: 'update' })
      }
    },
    [client]
  )

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {/* BottomDrawer already scrolls above keyboard; nested capped ScrollView clipped lower controls. */}
      <View>
        <Text style={styles.heading}>
          {t('components.dictationSetupSheet.title', 'Set up voice dictation')}
        </Text>
        <Text style={styles.subtitle}>
          {t(
            'components.dictationSetupSheet.description',
            'Download or pick a model and enable dictation on the paired computer — all from here.'
          )}
        </Text>

        {setup === null ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : (
          <>
            <View style={styles.enableRow}>
              <Text style={styles.enableLabel}>
                {t('components.dictationSetupSheet.enabled', 'Dictation enabled')}
              </Text>
              <MobileSwitch
                accessibilityLabel={t(
                  'components.dictationSetupSheet.enabled',
                  'Dictation enabled'
                )}
                value={setup.enabled === true}
                onValueChange={(v) => void handleToggleEnabled(v)}
              />
            </View>

            {setup.models.map((model) => {
              const action = dictationModelRowAction(model, setup.selectedModelId)
              const rowBusy = busy === model.id
              return (
                <View key={model.id} style={styles.modelRow}>
                  <View style={styles.modelInfo}>
                    <View style={styles.modelTitleRow}>
                      <Text style={styles.modelLabel}>{model.label}</Text>
                      {model.recommended ? (
                        <Text style={styles.recommended}>
                          {t('components.dictationSetupSheet.recommended', 'Recommended')}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.modelMeta}>{modelMetadata(model, t)}</Text>
                  </View>
                  {action === 'needs-api-key' ? (
                    <Text style={styles.modelStateText}>{cloudModelNeedsKey()}</Text>
                  ) : action === 'in-use' ? (
                    <View style={styles.selectedTag}>
                      <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
                      <Text style={styles.selectedText}>
                        {t('components.dictationSetupSheet.inUse', 'In use')}
                      </Text>
                    </View>
                  ) : action === 'use' ? (
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        pressed && styles.actionPressed
                      ]}
                      disabled={rowBusy}
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        'components.dictationSetupSheet.useModel',
                        'Use {{model}}',
                        { model: model.label }
                      )}
                      accessibilityState={{ disabled: rowBusy }}
                      onPress={() => void handleUseModel(model)}
                    >
                      <Text style={styles.actionText}>
                        {t('components.dictationSetupSheet.use', 'Use')}
                      </Text>
                    </Pressable>
                  ) : action === 'downloading' ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        pressed && styles.actionPressed
                      ]}
                      disabled={rowBusy}
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        'components.dictationSetupSheet.downloadModel',
                        'Download {{model}}',
                        { model: model.label }
                      )}
                      accessibilityState={{ disabled: rowBusy }}
                      onPress={() => void handleDownload(model)}
                    >
                      {rowBusy ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : (
                        <>
                          <Download size={13} color={colors.textSecondary} strokeWidth={2.2} />
                          <Text style={styles.actionText}>
                            {t('components.dictationSetupSheet.download', 'Download')}
                          </Text>
                        </>
                      )}
                    </Pressable>
                  )}
                </View>
              )
            })}
          </>
        )}
        {error ? <Text style={styles.error}>{setupErrorMessage(error, t)}</Text> : null}
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs,
    marginBottom: spacing.md
  },
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  enableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    marginBottom: spacing.sm
  },
  enableLabel: { color: colors.textPrimary, fontSize: typography.bodySize },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm
  },
  modelInfo: { flex: 1, minWidth: 0 },
  modelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modelLabel: { color: colors.textPrimary, fontSize: typography.bodySize },
  recommended: {
    color: colors.statusGreen,
    fontSize: 10,
    fontWeight: '700'
  },
  modelMeta: { color: colors.textMuted, fontSize: typography.metaSize, marginTop: 2 },
  modelStateText: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  actionPressed: { opacity: 0.7 },
  actionText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  selectedTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectedText: { color: colors.statusGreen, fontSize: typography.metaSize, fontWeight: '600' },
  error: { color: colors.statusRed, fontSize: typography.metaSize, marginTop: spacing.md }
}))
