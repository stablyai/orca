import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ExternalLink, RadioTower, RotateCw } from 'lucide-react-native'
import type { AgentSessionProviderRemoteControl } from '../../../../../src/shared/agent-session/remote-control/agent-session-provider-remote-control'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { openExternalLink } from '../../../platform/external-links/external-link'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { queuedMessageStyles } from '../input/queued-messages/mobile-native-chat-queued-message-styles'
import { MobileClaudeRemoteControlIcon } from './MobileClaudeRemoteControlIcon'
import type { MobileStructuredRemoteControl } from './use-mobile-structured-remote-control'

type Translate = ReturnType<typeof useMobileTranslation>

/** The strip's short state after its bold "Remote Control", as the goal strip reads. */
function stateText(link: AgentSessionProviderRemoteControl | undefined, t: Translate): string {
  switch (link?.state) {
    case undefined:
      return t('chat.remoteControl.stateOnNextMessage', 'on next message')
    case 'connected':
      return t('chat.remoteControl.stateConnected', 'connected')
    case 'connecting':
      return t('chat.remoteControl.stateConnecting', 'connecting…')
    case 'failed':
      return link.detail
        ? t('chat.remoteControl.stateFailedWithDetail', 'failed: {{detail}}', {
            detail: link.detail
          })
        : t('chat.remoteControl.stateFailed', 'failed')
    case 'policy-disabled':
      return t('chat.remoteControl.stateOffByOrganization', 'off by your organization')
  }
}

/** A Claude chat's Remote Control on the composer's top edge, shown while it has a link. */
export function MobileNativeChatRemoteControlStrip({
  remoteControl
}: {
  remoteControl: MobileStructuredRemoteControl | null | undefined
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const link = remoteControl?.link
  if (!remoteControl || (!link && !remoteControl.pending)) {
    return null
  }
  const { toggle, retry } = remoteControl
  const run = (action: () => Promise<boolean>): void => {
    setBusy(true)
    setFailed(false)
    void action()
      .then((saved) => setFailed(!saved))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }
  const url = link?.sessionUrl
  const warn = failed || link?.state === 'failed' || link?.state === 'policy-disabled'
  return (
    <View
      style={[queuedMessageStyles.box, queuedMessageStyles.composerTab, styles.strip]}
      testID="remote-control-strip"
    >
      <MobileClaudeRemoteControlIcon size={14} surface="panel" />
      <Text style={[styles.text, warn && styles.warning]} numberOfLines={2}>
        <Text style={styles.status}>{t('chat.remoteControl.label', 'Remote Control')}</Text>{' '}
        {link?.enabledByDefault
          ? `${t('chat.remoteControl.onByDefault', 'on by default')} · `
          : null}
        {failed ? t('chat.remoteControl.changeFailed', "couldn't change it") : stateText(link, t)}
      </Text>
      {url ? (
        <StripAction
          label={t('chat.remoteControl.openOnClaudeAi', 'Open on claude.ai')}
          iconOnly
          icon={<ExternalLink size={14} color={colors.textPrimary} strokeWidth={2} />}
          onPress={() => openExternalLink(url)}
        />
      ) : null}
      {link?.state === 'failed' ? (
        <StripAction
          label={t('chat.remoteControl.retry', 'Retry')}
          icon={<RotateCw size={13} color={colors.textPrimary} strokeWidth={2} />}
          disabled={busy}
          onPress={() => run(retry)}
        />
      ) : link?.state !== 'policy-disabled' ? (
        <StripAction
          label={
            link
              ? t('chat.remoteControl.disconnect', 'Disconnect')
              : t('chat.remoteControl.turnOff', 'Turn off')
          }
          icon={<RadioTower size={13} color={colors.textPrimary} strokeWidth={2} />}
          disabled={busy}
          onPress={() => run(toggle)}
        />
      ) : null}
    </View>
  )
}

function StripAction(props: {
  label: string
  icon: React.ReactNode
  /** A secondary action shows its icon alone; its label stays its accessible name. */
  iconOnly?: true
  disabled?: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.actionPressed,
        props.disabled && styles.disabled
      ]}
      onPress={props.onPress}
    >
      {props.icon}
      {props.iconOnly ? null : <Text style={styles.actionLabel}>{props.label}</Text>}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  strip: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  warning: {
    color: colors.statusAmber
  },
  status: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill
  },
  actionPressed: {
    opacity: 0.6
  },
  disabled: {
    opacity: 0.4
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  }
}))
