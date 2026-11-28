import { useRef, useState } from 'react'
import type { TextInputInstance } from 'react-native'
import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { groupFieldStylesSheet } from '../../../components/composer-input/composer-input-styles'
import { TextField } from '../../../components/composer-input/TextField'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { SettingsNote, SettingsSection } from '../../../settings/settings-screen-frame'
import { openExternalLink } from '../../../platform/external-links/external-link'
import { useThemedStyles } from '../../../theme/themed-styles'
import { JiraConnectRefusedError } from './mobile-jira-operations'

const EMPTY_DRAFT = { siteUrl: '', email: '', apiToken: '' }

export function renderMobileTasksJiraConnectDrawer(model: ConnectionPresentationModel) {
  return <MobileTasksJiraConnectDrawer model={model} />
}

// Jira Cloud setup, drawn like Connect Linear: Cancel · Connect Jira · Connect over site, email and token.
function MobileTasksJiraConnectDrawer({ model }: { model: ConnectionPresentationModel }) {
  const { connectJiraAccount, setShowJiraConnect, showJiraConnect, taskUiReady } = model
  const t = useMobileTranslation()
  const groupFieldStyles = useThemedStyles(groupFieldStylesSheet)
  const emailRef = useRef<TextInputInstance>(null)
  const tokenRef = useRef<TextInputInstance>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const visible = taskUiReady && showJiraConnect
  // Each open starts empty so a token typed earlier never lingers in a reopened sheet.
  const [wasVisible, setWasVisible] = useState(visible)
  if (wasVisible !== visible) {
    setWasVisible(visible)
    if (visible) {
      setDraft(EMPTY_DRAFT)
      setError('')
    }
  }
  const ready = Boolean(draft.siteUrl.trim() && draft.email.trim() && draft.apiToken.trim())
  const close = () => {
    if (!connecting) {
      setShowJiraConnect(false)
    }
  }
  const edit = (field: keyof typeof EMPTY_DRAFT) => (next: string) => {
    setDraft((current) => ({ ...current, [field]: next }))
    setError('')
  }
  const connect = async () => {
    if (!ready || connecting) {
      return
    }
    setConnecting(true)
    setError('')
    try {
      await connectJiraAccount({
        siteUrl: draft.siteUrl.trim(),
        email: draft.email.trim(),
        apiToken: draft.apiToken.trim()
      })
      setShowJiraConnect(false)
    } catch (err) {
      setError(
        err instanceof JiraConnectRefusedError
          ? t(
              'tasks.jiraConnect.serverNeedsUpdate',
              'This server needs an Orca update first. Connect Jira in Orca desktop instead.'
            )
          : err instanceof Error && err.message
            ? err.message
            : t('tasks.jiraConnect.failed', 'Connection failed')
      )
    } finally {
      setConnecting(false)
    }
  }
  return (
    <BottomDrawer visible={visible} dismissible={!connecting} onClose={close}>
      <SheetHeader
        title={t('tasks.jiraConnect.title', 'Connect Jira')}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: close, disabled: connecting }}
        trailing={{
          label: t('tasks.tasksCreateDrawers.connect', 'Connect'),
          onPress: () => void connect(),
          disabled: !ready,
          busy: connecting
        }}
      />
      <ListGroup style={groupFieldStyles.underHeader}>
        <TextField
          key="site"
          value={draft.siteUrl}
          onChangeText={edit('siteUrl')}
          placeholder={t('tasks.jiraConnect.siteUrl', 'your-team.atlassian.net')}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="next"
          editable={!connecting}
          onSubmitEditing={() => emailRef.current?.focus()}
          style={groupFieldStyles.line}
        />
        <TextField
          key="email"
          inputRef={emailRef}
          value={draft.email}
          onChangeText={edit('email')}
          placeholder={t('tasks.jiraConnect.email', 'Atlassian email')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
          editable={!connecting}
          onSubmitEditing={() => tokenRef.current?.focus()}
          style={groupFieldStyles.line}
        />
        <TextField
          key="token"
          inputRef={tokenRef}
          value={draft.apiToken}
          onChangeText={edit('apiToken')}
          placeholder={t('tasks.jiraConnect.apiToken', 'API token')}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="done"
          editable={!connecting}
          onSubmitEditing={() => void connect()}
          style={groupFieldStyles.line}
        />
      </ListGroup>
      {error ? (
        <SettingsNote error>{error}</SettingsNote>
      ) : (
        <SettingsNote>
          {t(
            'tasks.jiraConnect.storageHint',
            'Your token is stored on this host, encrypted where its OS supports it.'
          )}
        </SettingsNote>
      )}
      <SettingsSection>
        <ListRow
          title={t('tasks.jiraConnect.createToken', 'Create an API token')}
          accent
          accessibilityRole="link"
          onPress={() =>
            void openExternalLink('https://id.atlassian.com/manage-profile/security/api-tokens')
          }
        />
      </SettingsSection>
    </BottomDrawer>
  )
}
