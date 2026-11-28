// Sign in to Claude or Codex on the paired computer, as bot import's numbered steps: open the page
// in the phone's browser, then paste its code back (Claude) or enter the shown code there (Codex).
// The desktop's HostAccountSignInPrompt.
import { useState } from 'react'
import { Text, View } from 'react-native'
import { ArrowUpRight, CircleAlert, Copy } from 'lucide-react-native'
import {
  isHostAccountSignInPage,
  type HostAccountSignInProvider
} from '../../../../src/shared/agent-accounts/host-account-sign-in-types'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { TextField } from '../../components/composer-input/TextField'
import { groupFieldStylesSheet } from '../../components/composer-input/composer-input-styles'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, ListRow } from '../../components/list/ListGroup'
import { ListStepMark } from '../../components/list/ListStepMark'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { HostAccountSignInTarget, HostAccountSignInView } from './use-host-account-sign-in'

// The host takes codes up to this long, as the desktop's field does.
const CODE_MAX_LENGTH = 4_096

export function MobileHostAccountSignInSheet(props: {
  target: HostAccountSignInTarget | null
  open: boolean
  view: HostAccountSignInView
  hostName: string
  onCancel: () => void
  onRetry: (target: HostAccountSignInTarget) => void
  submitCode: (code: string) => Promise<void>
}) {
  const t = useMobileTranslation()
  const { target, view } = props
  const shown: HostAccountSignInProvider = target?.provider ?? 'claude'
  const status = view.kind === 'running' ? view.status : null
  const prompt =
    status?.phase === 'waiting' || status?.phase === 'verifying' ? status.prompt : undefined
  // Only the provider's own sign-in page is ever opened.
  const url = prompt && isHostAccountSignInPage(shown, prompt.url) ? prompt.url : null
  return (
    <BottomDrawer visible={props.open} onClose={props.onCancel}>
      <SheetHeader
        title={
          shown === 'claude'
            ? t('accounts.hostSignIn.titleClaude', 'Sign in to Claude')
            : t('accounts.hostSignIn.titleCodex', 'Sign in to Codex')
        }
        subtitle={t('accounts.hostSignIn.savedOn', 'Saved on {{host}}', { host: props.hostName })}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel }}
      />
      {view.kind === 'failed' ? (
        <MobileStateView
          icon={CircleAlert}
          title={view.error}
          action={
            target
              ? {
                  label:
                    shown === 'codex'
                      ? t('accounts.hostSignIn.newCode', 'Get a new code')
                      : t('accounts.hostSignIn.tryAgain', 'Try again'),
                  onPress: () => props.onRetry(target)
                }
              : null
          }
        />
      ) : !url || !status ? (
        <MobileStateView
          loading
          title={t('accounts.hostSignIn.starting', 'Starting sign-in on {{host}}…', {
            host: props.hostName
          })}
        />
      ) : prompt?.needsCode ? (
        <PastedCodeSteps
          key={status.flowId}
          url={url}
          verifying={status.phase === 'verifying'}
          submitCode={props.submitCode}
        />
      ) : (
        <DeviceCodeSteps key={status.flowId} url={url} userCode={prompt?.userCode ?? null} />
      )}
    </BottomDrawer>
  )
}

function OpenPageRow(props: { n: number; opened: boolean; url: string; onOpened: () => void }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  return (
    <ListRow
      key="open"
      leading={<ListStepMark n={props.n} done={props.opened} />}
      title={t('accounts.hostSignIn.openPage', 'Open the sign-in page')}
      accessory={<ArrowUpRight size={16} color={colors.textMuted} strokeWidth={2.2} />}
      accessibilityRole="link"
      onPress={() => {
        // Ticked only once the phone's browser took the page; a refused open leaves step 1 to retry.
        void openExternalLink(props.url).then((opened) => opened && props.onOpened())
      }}
    />
  )
}

function CopyRow(props: { label: string; text: string }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const clipboard = useClipboardWriter()
  const [copied, setCopied] = useState(false)
  return (
    <ListRow
      key="copy"
      leading={<Copy size={16} color={colors.textSecondary} />}
      title={copied ? t('accounts.hostSignIn.copied', 'Copied') : props.label}
      onPress={() =>
        void clipboard.writeText(props.text).then(
          () => setCopied(true),
          () => undefined
        )
      }
    />
  )
}

/** Claude: the page shows a code after sign-in, which comes back here. */
function PastedCodeSteps(props: {
  url: string
  verifying: boolean
  submitCode: (code: string) => Promise<void>
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const trimmed = code.trim()
  const busy = sending || props.verifying
  const submit = () => {
    if (!trimmed || busy) {
      return
    }
    setSending(true)
    setRefusal(null)
    props
      .submitCode(trimmed)
      .catch((error: unknown) => setRefusal(error instanceof Error ? error.message : String(error)))
      .finally(() => setSending(false))
  }
  return (
    <>
      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        <OpenPageRow n={1} opened={opened} url={props.url} onOpened={() => setOpened(true)} />
        <CopyRow label={t('accounts.hostSignIn.copyLink', 'Copy link')} text={props.url} />
        <ListRow
          key="paste"
          leading={<ListStepMark n={2} done={props.verifying} />}
          title={t('accounts.hostSignIn.pasteStep', 'Paste the code')}
        />
      </SettingsSection>
      <SettingsSection>
        <TextField
          key="code"
          value={code}
          onChangeText={(text) => {
            setCode(text)
            setRefusal(null)
          }}
          placeholder={t('accounts.hostSignIn.codePlaceholder', 'Code from the page')}
          accessibilityLabel={t('accounts.hostSignIn.pasteStep', 'Paste the code')}
          monospace
          maxLength={CODE_MAX_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={submit}
          style={groupFieldStyles.line}
        />
      </SettingsSection>
      {refusal ? <SettingsNote error>{refusal}</SettingsNote> : null}
      <View style={styles.foot}>
        <SheetPrimaryButton
          label={
            busy
              ? t('accounts.hostSignIn.signingIn', 'Signing in…')
              : t('accounts.hostSignIn.continue', 'Continue')
          }
          busy={busy}
          disabled={!trimmed}
          onPress={submit}
        />
      </View>
    </>
  )
}

/** Codex: the page takes the shown code, and the computer hears when it's done. */
function DeviceCodeSteps(props: { url: string; userCode: string | null }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const [opened, setOpened] = useState(false)
  return (
    <>
      <SettingsSection separatorInset={LIST_LEADING_INSET}>
        <OpenPageRow n={1} opened={opened} url={props.url} onOpened={() => setOpened(true)} />
        {props.userCode ? (
          <ListRow
            key="enter"
            leading={<ListStepMark n={2} done={false} />}
            title={t('accounts.hostSignIn.enterCodeStep', 'Enter this code')}
          />
        ) : null}
        {props.userCode ? (
          <Text key="code" selectable style={styles.code}>
            {props.userCode}
          </Text>
        ) : null}
        {props.userCode ? (
          <CopyRow label={t('accounts.hostSignIn.copyCode', 'Copy code')} text={props.userCode} />
        ) : null}
      </SettingsSection>
      <View style={[styles.foot, styles.waiting]}>
        <LoadingSpinner size={16} color={colors.textSecondary} />
        <Text style={styles.waitingText}>
          {t('accounts.hostSignIn.waitingForPage', 'Waiting for you to finish on the page')}
        </Text>
      </View>
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  code: {
    fontFamily: typography.monoFamily,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: 3,
    textAlign: 'center',
    color: colors.textPrimary,
    paddingTop: 18,
    paddingBottom: 16
  },
  foot: { paddingTop: spacing.md, paddingBottom: spacing.md },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  waitingText: { fontSize: 13, color: colors.textSecondary }
}))
