import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { FieldTextInput } from '../../components/composer-input/FieldTextInput'
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

/** The streamed page's permission, sign-in or open-app prompt, on the page dialog's card. */
export function MobileBrowserPagePrompt({
  prompt,
  keyboardLift,
  answer
}: {
  prompt: MobileBrowserPagePromptState
  keyboardLift: number
  answer: (value: unknown) => Promise<void>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const copy = promptCopy(prompt, t)
  const { kind } = prompt.request
  const accept = () =>
    void answer(
      kind === 'site-permission' ? 'allow' : kind === 'http-auth' ? { username, password } : true
    )
  // Block is remembered for the site, as on the desktop; Cancel only declines this time.
  const decline = () => void answer(kind === 'site-permission' ? 'block' : null)
  return (
    <View style={[styles.dialogOverlay, { paddingBottom: spacing.xl + keyboardLift }]}>
      <View style={styles.dialogCard}>
        <Text style={styles.dialogTitle}>{copy.title}</Text>
        {copy.lines.map((line) => (
          <Text key={line} style={styles.dialogMessage}>
            {line}
          </Text>
        ))}
        {kind === 'http-auth' ? (
          <>
            <FieldTextInput
              style={styles.dialogInput}
              value={username}
              onChangeText={setUsername}
              placeholder={t('browser.pagePrompt.username', 'Username')}
              accessibilityLabel={t('browser.pagePrompt.username', 'Username')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              autoFocus
              editable={!prompt.pending}
            />
            <FieldTextInput
              style={styles.dialogInput}
              value={password}
              onChangeText={setPassword}
              placeholder={t('browser.pagePrompt.password', 'Password')}
              accessibilityLabel={t('browser.pagePrompt.password', 'Password')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              secureTextEntry
              editable={!prompt.pending}
              onSubmitEditing={accept}
            />
          </>
        ) : null}
        {prompt.error ? <Text style={styles.dialogError}>{prompt.error}</Text> : null}
        <View style={styles.dialogActions}>
          <Pressable
            disabled={prompt.pending}
            style={({ pressed }) => [
              styles.dialogButton,
              pressed && styles.dialogButtonPressed,
              prompt.pending && styles.dialogButtonDisabled
            ]}
            onPress={decline}
          >
            <Text style={styles.dialogButtonText}>{copy.cancel}</Text>
          </Pressable>
          <Pressable
            disabled={prompt.pending}
            style={({ pressed }) => [
              styles.dialogButton,
              styles.dialogButtonPrimary,
              pressed && styles.dialogButtonPressed,
              prompt.pending && styles.dialogButtonDisabled
            ]}
            onPress={accept}
          >
            <Text style={[styles.dialogButtonText, styles.dialogButtonPrimaryText]}>
              {copy.confirm}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}
