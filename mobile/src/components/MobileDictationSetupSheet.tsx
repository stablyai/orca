import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Download } from 'lucide-react-native'
import { BottomDrawer } from './BottomDrawer'
import { MobileSwitch } from './MobileSwitch'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'
import { SheetHeader } from './ui/SheetHeader'
import { StateView } from './ui/StateView'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSelection, triggerSuccess } from '../platform/haptics'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  CLOUD_MODEL_NEEDS_KEY,
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

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) {
    return ''
  }
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** The row's grey line: where the model runs or its size, then download progress. */
function modelMeta(model: MobileSpeechModel): string {
  const parts = [
    model.recommended ? 'Recommended' : null,
    model.provider === 'openai' ? 'OpenAI API' : formatSize(model.sizeBytes) || null,
    isModelInFlight(model) && model.progress != null
      ? `${Math.round(model.progress * 100)}%`
      : model.status === 'extracting'
        ? 'Extracting…'
        : null
  ]
  return parts.filter((part) => part !== null).join(' · ')
}

// Lets the user enable dictation and download or pick a speech model on the paired
// computer, from the phone. Polls while a download is in flight.
export function MobileDictationSetupSheet({ visible, client, onClose, onReady }: Props) {
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
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
      setError(err instanceof Error ? err.message : 'Failed to load')
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
        setError(err instanceof Error ? err.message : 'Download failed')
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
        setError(err instanceof Error ? err.message : 'Could not select model')
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
      triggerSelection()
      try {
        setSetup(await setDictationConfig(client, { enabled }))
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? err.message : 'Could not update')
      }
    },
    [client]
  )

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {/* Why: BottomDrawer already scrolls its children in a keyboard-aware container;
          a nested capped ScrollView cut off the lower controls. */}
      <View style={styles.sheet}>
        <SheetHeader title="Voice dictation" trailing={{ label: 'Done', onPress: onClose }} />
        <Text style={styles.subtitle}>
          Pick or download a speech model and turn dictation on for the paired desktop, all from
          here.
        </Text>

        {setup === null ? (
          error ? null : (
            <StateView loading title="Loading dictation settings…" />
          )
        ) : (
          <>
            <ListGroup>
              <ListRow
                title="Dictation"
                accessory={
                  <MobileSwitch
                    accessibilityLabel="Dictation enabled"
                    value={setup.enabled === true}
                    onValueChange={(v) => void handleToggleEnabled(v)}
                  />
                }
              />
            </ListGroup>

            <SectionHeader title="Models" />
            <ListGroup>
              {setup.models.map((model) => {
                const action = dictationModelRowAction(model, setup.selectedModelId)
                const rowBusy = busy === model.id
                const meta = modelMeta(model)
                return (
                  <ListRow
                    key={model.id}
                    title={model.label ?? model.id}
                    subtitle={meta || undefined}
                    selected={action === 'in-use' ? true : undefined}
                    value={action === 'needs-api-key' ? CLOUD_MODEL_NEEDS_KEY : undefined}
                    accessibilityLabel={action === 'in-use' ? `${model.label}, in use` : undefined}
                    accessory={
                      action === 'use' ? (
                        <Button
                          label="Use"
                          size="compact"
                          accessibilityLabel={`Use ${model.label}`}
                          busy={rowBusy}
                          onPress={() => void handleUseModel(model)}
                        />
                      ) : action === 'downloading' ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : action === 'download' ? (
                        <Button
                          label="Download"
                          icon={Download}
                          size="compact"
                          accessibilityLabel={`Download ${model.label}`}
                          busy={rowBusy}
                          onPress={() => void handleDownload(model)}
                        />
                      ) : undefined
                    }
                  />
                )
              })}
            </ListGroup>
          </>
        )}
        {error ? (
          <View style={styles.error}>
            <Banner tone="error" title="Couldn't update dictation" message={error} />
          </View>
        ) : null}
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  // The drawer pads its content; the sheet's groups and text keep their own 16 and 20 pt edges.
  sheet: {
    marginHorizontal: -spacing.md,
    paddingBottom: spacing.lg
  },
  subtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg
  },
  error: {
    marginTop: spacing.lg
  }
})
