// Add a tool from the phone: pasting a server URL or start command is the whole job, and the host
// reads it as the desktop's Add a tool does (bots.tools.add with its source).
import { useState, type ReactNode } from 'react'
import { botToolNameFrom, freeBotToolName } from '../../../../src/shared/bot-tools'
import { ListRow, SectionHeader } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import { botToolAdd, type PhoneOwnTool } from './bot-tool-operations'
import type { ToolsBot } from './bot-tool-words'

export function MobileBotAddToolPage(props: {
  client: RpcClient | null
  bot: ToolsBot
  /** The bot's tool names, so the new one gets a free name. */
  taken: ReadonlySet<string>
  hostName: string
  online: boolean
  banner: ReactNode
  onCancel: () => void
  onAdded: (tool: PhoneOwnTool) => Promise<void>
}) {
  const t = useMobileTranslation()
  const [source, setSource] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackClaim(() => {
    if (!saving) {
      props.onCancel()
    }
    return true
  })
  const typed = source.trim()
  const url = /^https?:\/\//i.test(typed)
  const name = typed ? freeBotToolName(botToolNameFrom(typed), props.taken) : ''
  const add = () => {
    if (!props.client || !typed || saving || !props.online) {
      return
    }
    setSaving(true)
    setError(null)
    void botToolAdd
      .request(
        props.client,
        { botId: props.bot.id, source: typed, name },
        { failWhenDisconnected: true }
      )
      .then((response) => props.onAdded(botToolAdd.interpret(response).tool))
      .catch((caught: unknown) => {
        setSaving(false)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }
  return (
    <>
      <SheetHeader
        title={t('bots.tools.add', 'Add a tool')}
        subtitle={`${botAgentLabel(props.bot.agent)} · ${props.hostName}`}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel, disabled: saving }}
        trailing={{
          label: t('bots.tools.addButton', 'Add'),
          onPress: add,
          disabled: !typed || !props.online,
          busy: saving
        }}
      />
      {props.banner}
      <SectionHeader title={t('bots.tools.sourceLabel', 'Server URL or start command')} first />
      <TextField
        value={source}
        onChangeText={(next) => {
          setSource(next)
          setError(null)
        }}
        monospace
        placeholder={t('bots.tools.sourcePlaceholder', 'https://… or npx …')}
        accessibilityLabel={t('bots.tools.sourceLabel', 'Server URL or start command')}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      {error ? (
        <SettingsNote error>{error}</SettingsNote>
      ) : (
        <SettingsNote>
          {t('bots.tools.scope', 'Only {{name}} gets it, in addition to your own tools.', {
            name: props.bot.name
          })}
        </SettingsNote>
      )}
      {typed ? (
        <SettingsSection
          title={t('bots.tools.details', 'Details')}
          footer={
            url
              ? undefined
              : t(
                  'bots.tools.commandWarning',
                  'The command runs in this bot’s home folder on {{host}}. Adding or saving can start it during the native check. Only add software you trust.',
                  { host: props.hostName }
                )
          }
        >
          <ListRow
            key="type"
            title={t('bots.tools.serverType', 'Server type')}
            value={
              url
                ? t('bots.tools.urlMode', 'Connect to a URL')
                : t('bots.tools.commandMode', 'Run a command')
            }
          />
          <ListRow key="name" title={t('bots.tools.serverName', 'Server name')} value={name} />
        </SettingsSection>
      ) : null}
    </>
  )
}
