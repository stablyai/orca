// The desktop's Rotate key and signing secret dialogs, as pages inside Settings like its other confirms.
import { useState, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import {
  webhookAdapterGeneratesSecret,
  webhookAdapterName,
  webhookAdapterTakesPastedSecret
} from '../../../../src/shared/bots/webhook-card-view'
import {
  WEBHOOK_ADAPTERS,
  type WebhookAdapterId
} from '../../../../src/shared/connector-webhook-contract'
import { TextField } from '../../components/composer-input/TextField'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ListRow } from '../../components/list/ListGroup'
import {
  CheckRow,
  ChoiceRows,
  DrillRow
} from '../../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { PhoneWebhook } from './mobile-webhook-operations'

// A made secret is copied, never shown.
const SECRET_MASK = '••••••••'

/** Rotate key…: a new key, with the old one either kept a while or stopped now. */
export function MobileBotWebhookRotate(props: {
  hook: PhoneWebhook
  busy: boolean
  disabled: boolean
  onCancel: () => void
  onRotate: (stopNow: boolean) => void
}) {
  const t = useMobileTranslation()
  const [stopNow, setStopNow] = useState(false)
  const pending = props.hook.pendingCalls
  return (
    <>
      <SheetHeader
        title={t('bots.webhooks.rotate.confirm', 'Rotate key')}
        leading={{ label: t('bots.webhooks.cancel', 'Cancel'), onPress: props.onCancel }}
        trailing={{
          label: t('bots.webhooks.rotate.action', 'Rotate'),
          onPress: () => props.onRotate(stopNow),
          disabled: props.disabled,
          busy: props.busy
        }}
      />
      <SettingsSection
        first
        radioGroup
        footer={t(
          'bots.webhooks.rotate.note',
          'The URL gets a new key. Update every sender with it.'
        )}
      >
        <CheckRow
          radio
          label={t('bots.webhooks.rotate.overlap', 'Keep the old key working for 24 hours')}
          detail={t(
            'bots.webhooks.rotate.overlapNote',
            'Senders keep working while you update them.'
          )}
          checked={!stopNow}
          onPress={() => setStopNow(false)}
        />
        <CheckRow
          radio
          label={t('bots.webhooks.rotate.stop', 'Stop the old key now')}
          detail={
            pending > 0
              ? t(
                  'bots.webhooks.rotate.stopCancels',
                  'For a leaked key. {{count}} waiting calls it let in are cancelled.',
                  {
                    count: pending,
                    defaultValue_one:
                      'For a leaked key. {{count}} waiting call it let in is cancelled.'
                  }
                )
              : t('bots.webhooks.rotate.stopNote', 'For a leaked key.')
          }
          checked={stopNow}
          onPress={() => setStopNow(true)}
        />
      </SettingsSection>
    </>
  )
}

type MadeSecret = { adapter: WebhookAdapterId; secret: string }
// A save in flight, then its made secret until the ready page is done, outlive the page so leaving
// mid-Generate neither loses the secret nor lets a reopened page start a second one.
const secretSaves = new Map<string, MadeSecret | 'saving'>()
const secretSaveListeners = new Set<() => void>()

function setSecretSave(hookId: string, save: MadeSecret | 'saving' | null): void {
  if (save) {
    secretSaves.set(hookId, save)
  } else {
    secretSaves.delete(hookId)
  }
  secretSaveListeners.forEach((listener) => listener())
}

function onSecretSaves(listener: () => void): () => void {
  secretSaveListeners.add(listener)
  return () => secretSaveListeners.delete(listener)
}

/** The first of these hooks with a made secret its owner isn't done with. */
export function useWaitingWebhookSecret(hooks: readonly PhoneWebhook[]): string | null {
  return useSyncExternalStore(
    onSecretSaves,
    () => hooks.find((hook) => typeof secretSaves.get(hook.hookId) === 'object')?.hookId ?? null
  )
}

/** Add or change the signing secret: pick the sender, then paste its secret or have Orca make one. */
export function MobileBotWebhookSecret(props: {
  hook: PhoneWebhook
  busy: boolean
  disabled: boolean
  showToast: (message: string) => void
  onDone: () => void
  /** Null asks the host to make one. Resolves to the made secret, null once a pasted one is saved, or
   *  false when the host refused. */
  onSave: (adapter: WebhookAdapterId, secret: string | null) => Promise<string | null | false>
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [adapter, setAdapter] = useState<WebhookAdapterId>(props.hook.adapter ?? 'standard')
  const [mode, setMode] = useState<'generate' | 'paste'>('generate')
  const [secret, setSecret] = useState('')
  const [pickingSender, setPickingSender] = useState(false)
  // A made secret is copied, never shown, and kept only until its ready page is done.
  const saved = useSyncExternalStore(onSecretSaves, () => secretSaves.get(props.hook.hookId))
  const generated = typeof saved === 'object' ? saved : null
  const busy = props.busy || saved === 'saving'
  const finish = () => {
    setSecretSave(props.hook.hookId, null)
    props.onDone()
  }
  // This page owns Back on its step: it waits out a save, and on the ready page is Done.
  useBackClaim(() => {
    if (generated) {
      finish()
    } else if (!busy) {
      props.onDone()
    }
    return true
  })
  const choosesMode =
    webhookAdapterGeneratesSecret(adapter) && webhookAdapterTakesPastedSecret(adapter)
  const generates = webhookAdapterGeneratesSecret(adapter) && (!choosesMode || mode === 'generate')
  const sender = webhookAdapterName(adapter)

  if (generated) {
    return (
      <>
        <SheetHeader
          title={t('bots.webhooks.secret.generatedTitle', 'Signing secret ready')}
          trailing={{ label: t('bots.webhooks.secret.done', 'Done'), onPress: finish }}
        />
        <SettingsSection
          first
          footer={t(
            'bots.webhooks.secret.copyInto',
            'Copy it into {{sender}}’s webhook settings.',
            {
              sender: webhookAdapterName(generated.adapter)
            }
          )}
        >
          <ListRow
            title={t('bots.webhooks.secret.title', 'Signing secret')}
            subtitle={SECRET_MASK}
            subtitleMono
            accessory={
              <MobileBotTextButton
                label={t('bots.webhooks.copy', 'Copy')}
                accessibilityLabel={t('bots.webhooks.secret.copy', 'Copy secret')}
                accent
                onPress={() =>
                  void clipboard.writeText(generated.secret).then(
                    () => props.showToast(t('bots.webhooks.secret.copied', 'Secret copied')),
                    () =>
                      props.showToast(t('bots.webhooks.copyFailed', 'Couldn’t copy. Try again.'))
                  )
                }
              />
            }
          />
        </SettingsSection>
      </>
    )
  }
  if (pickingSender) {
    return (
      <SenderPicker
        adapter={adapter}
        onPick={(next) => {
          setAdapter(next)
          setPickingSender(false)
        }}
        onBack={() => setPickingSender(false)}
      />
    )
  }
  const save = async () => {
    setSecretSave(props.hook.hookId, 'saving')
    // A reply that won't decode rejects; it mustn't leave the hook marked as saving.
    const answer = await props
      .onSave(adapter, generates ? null : secret.trim())
      .catch(() => false as const)
    const made = generates && answer ? { adapter, secret: answer } : null
    setSecretSave(props.hook.hookId, made)
    if (answer !== false && !made) {
      props.onDone()
    }
  }
  return (
    <>
      <SheetHeader
        title={
          props.hook.adapter
            ? t('bots.webhooks.secret.changeTitle', 'Change signing secret')
            : t('bots.webhooks.secret.addTitle', 'Add signing secret')
        }
        leading={{
          label: t('bots.webhooks.cancel', 'Cancel'),
          onPress: props.onDone,
          disabled: busy
        }}
        trailing={{
          label: generates
            ? t('bots.webhooks.secret.create', 'Create')
            : t('bots.webhooks.secret.save', 'Save'),
          onPress: () => void save(),
          disabled: props.disabled || (!generates && secret.trim().length === 0),
          busy
        }}
      />
      <SettingsSection
        first
        footer={
          generates && !choosesMode
            ? t(
                'bots.webhooks.secret.generateNote',
                'Orca makes this secret. You copy it into {{sender}} next.',
                { sender }
              )
            : undefined
        }
      >
        <DrillRow
          label={t('bots.webhooks.secret.sender', 'Sender')}
          value={sender}
          onPress={() => setPickingSender(true)}
          disabled={busy}
        />
      </SettingsSection>
      {choosesMode ? (
        <MobileSegmentedControl
          segments={[
            { value: 'generate', label: t('bots.webhooks.secret.modeGenerate', 'Orca makes one') },
            { value: 'paste', label: t('bots.webhooks.secret.modePaste', 'Paste the sender’s') }
          ]}
          selected={mode}
          onSelect={setMode}
          fill
          onSheet
          style={styles.gap}
        />
      ) : null}
      {generates ? (
        choosesMode ? (
          <SettingsNote>
            {t(
              'bots.webhooks.secret.generateNote',
              'Orca makes this secret. You copy it into {{sender}} next.',
              { sender }
            )}
          </SettingsNote>
        ) : null
      ) : (
        <View style={styles.gap}>
          <TextField
            label={t('bots.webhooks.secret.paste', '{{sender}} secret', { sender })}
            value={secret}
            onChangeText={setSecret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
          />
        </View>
      )}
    </>
  )
}

/** Back returns to the signing secret form, keeping what was typed there. */
function SenderPicker(props: {
  adapter: WebhookAdapterId
  onPick: (adapter: WebhookAdapterId) => void
  onBack: () => void
}) {
  const t = useMobileTranslation()
  useBackClaim(() => {
    props.onBack()
    return true
  })
  return (
    <>
      <SheetHeader
        title={t('bots.webhooks.secret.sender', 'Sender')}
        onBack={{
          label: t('bots.webhooks.secret.back', 'Back to signing secret'),
          onPress: props.onBack
        }}
      />
      <ChoiceRows
        choices={WEBHOOK_ADAPTERS.map((id) => ({ id, label: webhookAdapterName(id) }))}
        selected={props.adapter}
        onSelect={props.onPick}
      />
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  gap: { marginTop: spacing.lg }
}))
