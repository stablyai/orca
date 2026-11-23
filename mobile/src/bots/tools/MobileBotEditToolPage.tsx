// Edit a tool from the phone: the desktop's Edit tool dialog (BotToolEditor) as a page, saved with
// bots.tools.update. Saved header and variable values never reach the phone, only their names.
import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { Plus } from '../../components/icons/app-icons'
import { freeBotToolName, type BotToolDetails } from '../../../../src/shared/bot-tools'
import {
  botToolDraftError,
  botToolDraftInput,
  draftFromServer,
  type BotToolDraft
} from '../../../../src/shared/bots/bot-tool-draft'
import { createNonSecureContextUuid as createUuid } from '../../../../src/shared/identifiers/non-secure-context-uuid'
import { LIST_ROW_PADDING, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileBotToolSecretRows as SecretRows } from './MobileBotToolSecretRows'
import {
  botToolContextRead,
  botToolDetailsRead,
  botToolUpdate,
  type PhoneOwnTool
} from './bot-tool-operations'
import type { ToolsBot } from './bot-tool-words'

type Loaded = { folder: string; platform: NodeJS.Platform; saved: BotToolDetails }

export function MobileBotEditToolPage(props: {
  client: RpcClient | null
  bot: ToolsBot
  name: string
  /** The bot's other tool names, so a rename stays free. */
  taken: ReadonlySet<string>
  hostName: string
  online: boolean
  banner: ReactNode
  onCancel: () => void
  onSaved: (tool: PhoneOwnTool) => Promise<void>
}) {
  const t = useMobileTranslation()
  const { client, bot, name } = props
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState<BotToolDraft | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackClaim(() => {
    if (!saving) {
      props.onCancel()
    }
    return true
  })
  // Read again when the host comes back if the first read never landed.
  const needsRead = loaded === null && props.online
  useEffect(() => {
    if (!client || !needsRead) {
      return
    }
    let live = true
    setReadError(null)
    void Promise.all([
      botToolContextRead.request(client, { botId: bot.id }),
      botToolDetailsRead.request(client, { botId: bot.id, name })
    ])
      .then(([contextResponse, detailsResponse]) => {
        const context = botToolContextRead.interpret(contextResponse)
        const saved: BotToolDetails = botToolDetailsRead.interpret(detailsResponse)
        if (live) {
          setLoaded({ folder: context.folder, platform: context.platform, saved })
          setDraft(draftFromServer(saved.server))
        }
      })
      .catch((caught: unknown) => {
        if (live) {
          setReadError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    return () => {
      live = false
    }
  }, [client, bot.id, name, needsRead])
  const collision = draft !== null && props.taken.has(draft.name)
  const invalid =
    draft && loaded ? botToolDraftError(draft, loaded.platform, t, loaded.saved) : null
  const save = () => {
    if (!client || !draft || !loaded || saving || invalid || collision || !props.online) {
      return
    }
    setSaving(true)
    setError(null)
    void botToolUpdate
      .request(
        client,
        { botId: bot.id, name, version: loaded.saved.version, config: botToolDraftInput(draft) },
        { failWhenDisconnected: true }
      )
      .then((response) => props.onSaved(botToolUpdate.interpret(response).tool))
      .catch((caught: unknown) => {
        setSaving(false)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }
  const patch = (changes: Partial<BotToolDraft>) => {
    if (draft) {
      setDraft({ ...draft, ...changes })
      setError(null)
    }
  }
  const editable = !saving && props.online
  return (
    <>
      <SheetHeader
        title={t('bots.tools.editTitle', 'Edit tool')}
        subtitle={`${botAgentLabel(bot.agent)} · ${props.hostName}`}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel, disabled: saving }}
        trailing={{
          label: t('bots.tools.save', 'Save'),
          onPress: save,
          disabled: !draft || Boolean(invalid) || collision || !props.online,
          busy: saving
        }}
      />
      {props.banner}
      {!draft || !loaded ? (
        <SettingsNote error={readError !== null}>
          {readError ?? t('bots.tools.reading', 'Reading tool details…')}
        </SettingsNote>
      ) : (
        <>
          <SettingsNote>
            {t('bots.tools.scope', 'Only {{name}} gets it, in addition to your own tools.', {
              name: bot.name
            })}
          </SettingsNote>
          <SectionHeader title={t('bots.tools.serverType', 'Server type')} />
          <MobileSegmentedControl
            segments={[
              { value: 'url', label: t('bots.tools.urlMode', 'Connect to a URL') },
              { value: 'command', label: t('bots.tools.commandMode', 'Run a command') }
            ]}
            selected={draft.mode}
            onSelect={(mode) => editable && patch({ mode })}
            fill
            onSheet
          />
          <SectionHeader title={t('bots.tools.serverName', 'Server name')} />
          <TextField
            value={draft.name}
            onChangeText={(next) => patch({ name: next })}
            maxLength={64}
            accessibilityLabel={t('bots.tools.serverName', 'Server name')}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
          />
          {collision ? (
            <>
              <SettingsNote error>
                {t(
                  'bots.tools.nameTaken',
                  'A tool named {{name}} already exists. Choose another name.',
                  { name: draft.name }
                )}
              </SettingsNote>
              <View style={styles.collision}>
                <MobileBotTextButton
                  label={t('bots.tools.useName', 'Use {{name}}', {
                    name: freeBotToolName(draft.name, props.taken)
                  })}
                  disabled={!editable}
                  onPress={() => patch({ name: freeBotToolName(draft.name, props.taken) })}
                />
              </View>
            </>
          ) : null}
          {draft.mode === 'url' ? (
            <>
              <SectionHeader title={t('bots.tools.url', 'Server URL')} />
              <TextField
                value={draft.url}
                onChangeText={(next) => patch({ url: next })}
                monospace
                placeholder={t('bots.tools.urlPlaceholder', 'https://example.com/mcp')}
                accessibilityLabel={t('bots.tools.url', 'Server URL')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={editable}
              />
              <SettingsNote>
                {t(
                  'bots.tools.transport',
                  'Streamable HTTP · localhost means this bot’s computer.'
                )}
              </SettingsNote>
              <SecretRows
                kind="header"
                rows={draft.headers}
                editable={editable}
                onChange={(headers) => patch({ headers })}
              />
              <SettingsNote>
                {t(
                  'bots.tools.authHint',
                  'If the server needs browser sign-in, Connect appears after its native check.'
                )}
              </SettingsNote>
            </>
          ) : (
            <>
              <SectionHeader title={t('bots.tools.executable', 'Executable')} />
              <TextField
                value={draft.command}
                onChangeText={(next) => patch({ command: next })}
                monospace
                placeholder={t('bots.tools.commandPlaceholder', 'npx')}
                accessibilityLabel={t('bots.tools.executable', 'Executable')}
                autoCapitalize="none"
                autoCorrect={false}
                editable={editable}
              />
              <SectionHeader title={t('bots.tools.args', 'Arguments')} />
              {draft.args.map((arg, index) => (
                <TextField
                  key={arg.id}
                  style={styles.stacked}
                  value={arg.value}
                  onChangeText={(next) =>
                    patch({
                      args: draft.args.map((entry, i) =>
                        i === index ? { ...entry, value: next } : entry
                      )
                    })
                  }
                  monospace
                  accessibilityLabel={t('bots.tools.argumentLabel', 'Argument {{index}}', {
                    index: index + 1
                  })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={editable}
                  trailing={
                    <MobileBotTextButton
                      label={t('bots.tools.remove', 'Remove')}
                      accessibilityLabel={t(
                        'bots.tools.removeArgumentLabel',
                        'Remove argument {{index}}',
                        { index: index + 1 }
                      )}
                      disabled={!editable}
                      onPress={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                    />
                  }
                />
              ))}
              <SettingsSection
                footer={t(
                  'bots.tools.argsHint',
                  'One exact argument per row. Spaces and empty arguments are preserved.'
                )}
              >
                <ListRow
                  title={t('bots.tools.addArg', 'Add argument')}
                  leading={<Plus size={18} color={colors.textMuted} />}
                  disabled={!editable}
                  onPress={() => patch({ args: [...draft.args, { id: createUuid(), value: '' }] })}
                />
              </SettingsSection>
              <SecretRows
                kind="variable"
                rows={draft.env}
                editable={editable}
                onChange={(env) => patch({ env })}
              />
            </>
          )}
          {error || invalid ? <SettingsNote error>{error ?? invalid}</SettingsNote> : null}
          <SettingsNote>
            {t('bots.tools.workingFolder', 'Working folder: {{folder}}', {
              folder: loaded.folder
            })}
          </SettingsNote>
          {draft.mode === 'command' ? (
            <SettingsNote>
              {t(
                'bots.tools.commandWarning',
                'The command runs in this bot’s home folder on {{host}}. Adding or saving can start it during the native check. Only add software you trust.',
                { host: props.hostName }
              )}
            </SettingsNote>
          ) : null}
        </>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  stacked: { marginBottom: spacing.sm },
  // Lines the button's label up with the note above it.
  collision: { alignItems: 'flex-start', paddingHorizontal: LIST_ROW_PADDING - spacing.xs }
}))
