import { useState } from 'react'
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { TextField } from '../../components/composer-input/TextField'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { useLastShownData } from '../../query/use-last-shown-data'
import { BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN } from '../../../../src/shared/browser/site-settings/browser-site-permission'
import type { MobileBrowserPagePromptState } from '../page-interaction/use-mobile-browser-page-prompts'
import {
  mobileBrowserPermissionLine,
  mobileBrowserSiteName
} from './mobile-browser-page-prompt-copy'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'

type Translate = ReturnType<typeof useMobileTranslation>

/** Title, lines and buttons for one prompt, worded as the desktop's dialog. */
function promptCopy(state: MobileBrowserPagePromptState, t: Translate) {
  const { request } = state
  switch (request.kind) {
    case 'site-permission': {
      const { origin, permissions } = request.details
      return {
        title:
          origin === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
            ? t('browser.pagePrompt.fileTitle', 'This file wants to')
            : t('browser.pagePrompt.permissionTitle', '{{site}} wants to', {
                site: mobileBrowserSiteName(origin)
              }),
        lines: permissions.map(mobileBrowserPermissionLine),
        cancel: t('browser.pagePrompt.block', 'Block'),
        confirm: t('browser.pagePrompt.allow', 'Allow')
      }
    }
    case 'http-auth': {
      const { origin, retry } = request.details
      return {
        title: t('browser.pagePrompt.signInTitle', 'Sign in'),
        lines: [
          t(
            'browser.pagePrompt.signInDescription',
            '{{origin}} is asking for a username and password.',
            {
              origin
            }
          ),
          ...(origin.startsWith('http:')
            ? [
                t(
                  'browser.pagePrompt.signInInsecure',
                  "Your connection to this site isn't private."
                )
              ]
            : []),
          ...(retry
            ? [t('browser.pagePrompt.signInRetry', "That username or password didn't work.")]
            : [])
        ],
        cancel: t('common.cancel', 'Cancel'),
        confirm: t('browser.pagePrompt.signIn', 'Sign in')
      }
    }
    case 'external-app': {
      const { origin, scheme } = request.details
      return {
        title: t('browser.pagePrompt.openLinkTitle', 'Open this {{scheme}} link?', { scheme }),
        lines: [
          origin
            ? t(
                'browser.pagePrompt.openLinkDescription',
                '{{origin}} wants to open another application.',
                {
                  origin
                }
              )
            : t(
                'browser.pagePrompt.openLinkAnonymous',
                'A page in the browser wants to open another application.'
              )
        ],
        cancel: t('common.cancel', 'Cancel'),
        confirm: t('browser.pagePrompt.openLink', 'Open link')
      }
    }
  }
}

/** The streamed page's permission, sign-in or open-app prompt, as the app's confirm sheet. */
export function MobileBrowserPagePrompt({
  prompt,
  answer
}: {
  prompt: MobileBrowserPagePromptState | null
  answer: (value: unknown) => Promise<void>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // Kept through the sheet's close, after the host has taken the answer.
  const shown = useLastShownData(prompt ?? undefined, null)
  // A new sign-in prompt starts with empty fields.
  const [fieldsFor, setFieldsFor] = useState<string | null>(null)
  if (shown && shown.request.requestId !== fieldsFor) {
    setFieldsFor(shown.request.requestId)
    setUsername('')
    setPassword('')
  }
  if (!shown) {
    return null
  }
  const { kind } = shown.request
  const copy = promptCopy(shown, t)
  const respond = (value: unknown) => {
    if (prompt !== null && !shown.pending) {
      void answer(value)
    }
  }
  const accept = () =>
    respond(
      kind === 'site-permission' ? 'allow' : kind === 'http-auth' ? { username, password } : true
    )
  // Block is remembered for the site, as on the desktop; Cancel only declines this time.
  const decline = () => respond(kind === 'site-permission' ? 'block' : null)
  const [message, ...moreLines] = copy.lines
  return (
    <ConfirmModal
      visible={prompt !== null}
      // Only an answer closes it, so the page is never left waiting behind nothing.
      dismissible={false}
      title={copy.title}
      message={message}
      details={
        <>
          {moreLines.map((line) => (
            <Text key={line} style={styles.promptLine}>
              {line}
            </Text>
          ))}
          {kind === 'http-auth' ? (
            <View style={styles.promptFields}>
              <TextField
                value={username}
                onChangeText={setUsername}
                placeholder={t('browser.pagePrompt.username', 'Username')}
                accessibilityLabel={t('browser.pagePrompt.username', 'Username')}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                autoFocus
                editable={!shown.pending}
              />
              <TextField
                value={password}
                onChangeText={setPassword}
                placeholder={t('browser.pagePrompt.password', 'Password')}
                accessibilityLabel={t('browser.pagePrompt.password', 'Password')}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                secureTextEntry
                editable={!shown.pending}
                onSubmitEditing={accept}
              />
            </View>
          ) : null}
          {shown.error ? <Text style={styles.dialogError}>{shown.error}</Text> : null}
        </>
      }
      confirmLabel={copy.confirm}
      cancelLabel={copy.cancel}
      onConfirm={accept}
      onCancelPress={decline}
      onCancel={() => {}}
    />
  )
}
