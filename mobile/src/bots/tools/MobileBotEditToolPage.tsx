// Edit a tool from the phone: the desktop's Edit tool dialog (BotToolEditor) as one grouped list whose
// rows open a page per value, saved with bots.tools.update. Saved header and variable values never
// reach the phone, only their names.
import { useEffect, useState, type ReactNode } from 'react'
import { Plus } from '../../components/icons/app-icons'
import { freeBotToolName, type BotToolDetails } from '../../../../src/shared/bot-tools'
import {
  botToolDraftError,
  botToolDraftInput,
  draftFromServer,
  type BotToolDraft,
  type SecretDraft
} from '../../../../src/shared/bots/bot-tool-draft'
import { createNonSecureContextUuid as createUuid } from '../../../../src/shared/identifiers/non-secure-context-uuid'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import {
  botToolContextRead,
  botToolDetailsRead,
  botToolUpdate,
  type PhoneOwnTool
} from './bot-tool-operations'
import type { ToolsBot } from './bot-tool-words'
import { MobileBotToolValuePage } from './MobileBotToolValuePage'

type Loaded = { platform: NodeJS.Platform; saved: BotToolDetails }
type Sub =
  | { kind: 'type' | 'name' | 'url' | 'command' }
  | { kind: 'arg' | 'secret'; index: number | null }

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
  const [sub, setSub] = useState<Sub | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackClaim(() => {
    if (sub) {
      setSub(null)
    } else if (!saving) {
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
          setLoaded({ platform: context.platform, saved })
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
  const invalid =
    draft && loaded ? botToolDraftError(draft, loaded.platform, t, loaded.saved) : null
  const save = () => {
    if (!client || !draft || !loaded || saving || invalid || !props.online) {
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
  const header = (
    <SheetHeader
      title={t('bots.tools.editTitle', 'Edit tool')}
      subtitle={`${botAgentLabel(bot.agent)} · ${props.hostName}`}
      leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel, disabled: saving }}
      trailing={{
        label: t('bots.tools.save', 'Save'),
        onPress: save,
        disabled: !draft || Boolean(invalid) || !props.online,
        busy: saving
      }}
    />
  )
  if (!draft || !loaded) {
    return (
      <>
        {header}
        {props.banner}
        <SettingsNote error={readError !== null}>
          {readError ?? t('bots.tools.reading', 'Reading tool details…')}
        </SettingsNote>
      </>
    )
  }
  const patch = (changes: Partial<BotToolDraft>) => {
    setDraft({ ...draft, ...changes })
    setError(null)
    setSub(null)
  }
  const url = draft.mode === 'url'
  const secrets = url ? draft.headers : draft.env
  const setSecrets = (rows: SecretDraft[]) => patch(url ? { headers: rows } : { env: rows })
  const urlLabel = t('bots.tools.urlMode', 'Connect to a URL')
  const commandLabel = t('bots.tools.commandMode', 'Run a command')
  const close = () => setSub(null)
  if (sub?.kind === 'type') {
    return (
      <>
        <SheetHeader
          title={t('bots.tools.serverType', 'Server type')}
          onBack={{ label: t('bots.tools.editTitle', 'Edit tool'), onPress: close }}
        />
        <SettingsSection first radioGroup>
          <ListRow title={urlLabel} selected={url} onPress={() => patch({ mode: 'url' })} />
          <ListRow
            title={commandLabel}
            selected={!url}
            onPress={() => patch({ mode: 'command' })}
          />
        </SettingsSection>
      </>
    )
  }
  if (sub?.kind === 'name') {
    const label = t('bots.tools.serverName', 'Server name')
    return (
      <MobileBotToolValuePage
        title={label}
        initial={[draft.name]}
        fields={() => [{ label, required: true, maxLength: 64 }]}
        problem={([typed]) => {
          const next = typed.trim()
          return props.taken.has(next)
            ? {
                text: t(
                  'bots.tools.nameTaken',
                  'A tool named {{name}} already exists. Choose another name.',
                  { name: next }
                ),
                fix: {
                  label: t('bots.tools.useName', 'Use {{name}}', {
                    name: freeBotToolName(next, props.taken)
                  }),
                  values: [freeBotToolName(next, props.taken)]
                }
              }
            : null
        }}
        onCancel={close}
        onDone={([next]) => patch({ name: next.trim() })}
      />
    )
  }
  if (sub?.kind === 'url' || sub?.kind === 'command') {
    const label =
      sub.kind === 'url'
        ? t('bots.tools.url', 'Server URL')
        : t('bots.tools.executable', 'Executable')
    return (
      <MobileBotToolValuePage
        title={label}
        initial={[sub.kind === 'url' ? draft.url : draft.command]}
        fields={() => [
          {
            label,
            url: sub.kind === 'url',
            placeholder:
              sub.kind === 'url'
                ? t('bots.tools.urlPlaceholder', 'https://example.com/mcp')
                : t('bots.tools.commandPlaceholder', 'npx')
          }
        ]}
        onCancel={close}
        onDone={([next]) => patch(sub.kind === 'url' ? { url: next } : { command: next })}
      />
    )
  }
  if (sub?.kind === 'arg') {
    const index = sub.index
    return (
      <MobileBotToolValuePage
        title={t('bots.tools.argument', 'Argument')}
        initial={[index === null ? '' : draft.args[index].value]}
        fields={() => [{ label: t('bots.tools.argument', 'Argument') }]}
        remove={
          index === null
            ? undefined
            : {
                label: t('bots.tools.removeArgument', 'Remove argument'),
                onPress: () => patch({ args: draft.args.filter((_, i) => i !== index) })
              }
        }
        onCancel={close}
        onDone={([value]) =>
          patch({
            args:
              index === null
                ? [...draft.args, { id: createUuid(), value }]
                : draft.args.map((arg, i) => (i === index ? { ...arg, value } : arg))
          })
        }
      />
    )
  }
  if (sub?.kind === 'secret') {
    const index = sub.index
    const row = index === null ? null : secrets[index]
    // A renamed header or variable leaves its saved value behind, so it needs a new one.
    const keeps = (key: string) => row !== null && row.configured && key === row.key
    return (
      <MobileBotToolValuePage
        title={url ? t('bots.tools.header', 'Header') : t('bots.tools.variable', 'Variable')}
        initial={[row?.key ?? '', row?.value ?? '']}
        fields={([key]) => [
          { label: t('bots.tools.keyPlaceholder', 'Name'), required: true, maxLength: 256 },
          {
            label: t('bots.tools.valuePlaceholder', 'Value'),
            secret: true,
            maxLength: 4096,
            required: !keeps(key),
            placeholder: keeps(key)
              ? t('bots.tools.savedPlaceholder', 'Saved value · enter to replace')
              : undefined
          }
        ]}
        remove={
          index === null
            ? undefined
            : {
                label: url
                  ? t('bots.tools.removeHeaderRow', 'Remove header')
                  : t('bots.tools.removeVariableRow', 'Remove variable'),
                onPress: () => setSecrets(secrets.filter((_, i) => i !== index))
              }
        }
        onCancel={close}
        onDone={([key, value]) => {
          const next = {
            id: row?.id ?? createUuid(),
            key: key.trim(),
            value,
            configured: keeps(key)
          }
          setSecrets(
            index === null ? [...secrets, next] : secrets.map((r, i) => (i === index ? next : r))
          )
        }}
      />
    )
  }
  const editable = !saving && props.online
  const open = (next: Sub) => () => setSub(next)
  const add = (title: string, onPress: () => void) => (
    <ListRow
      key="add"
      title={title}
      leading={<Plus size={18} color={colors.textMuted} />}
      disabled={!editable}
      onPress={onPress}
    />
  )
  return (
    <>
      {header}
      {props.banner}
      <SettingsSection first>
        <ListRow
          key="type"
          title={t('bots.tools.serverType', 'Server type')}
          value={url ? urlLabel : commandLabel}
          navigates
          disabled={!editable}
          onPress={open({ kind: 'type' })}
        />
        <ListRow
          key="name"
          title={t('bots.tools.serverName', 'Server name')}
          value={draft.name}
          navigates
          disabled={!editable}
          onPress={open({ kind: 'name' })}
        />
        {url ? (
          <ListRow
            key="url"
            title={t('bots.tools.url', 'Server URL')}
            subtitle={draft.url}
            subtitleMono
            navigates
            disabled={!editable}
            onPress={open({ kind: 'url' })}
          />
        ) : (
          <ListRow
            key="command"
            title={t('bots.tools.executable', 'Executable')}
            value={draft.command}
            navigates
            disabled={!editable}
            onPress={open({ kind: 'command' })}
          />
        )}
      </SettingsSection>
      {url ? null : (
        <SettingsSection title={t('bots.tools.args', 'Arguments')}>
          {draft.args.map((arg, index) => (
            <ListRow
              key={arg.id}
              title={arg.value || t('bots.tools.emptyArgument', 'Empty')}
              navigates
              disabled={!editable}
              onPress={open({ kind: 'arg', index })}
            />
          ))}
          {add(t('bots.tools.addArg', 'Add argument'), open({ kind: 'arg', index: null }))}
        </SettingsSection>
      )}
      <SettingsSection
        title={
          url ? t('bots.tools.headers', 'Headers') : t('bots.tools.env', 'Environment variables')
        }
      >
        {secrets.map((row, index) => (
          <ListRow
            key={row.id}
            title={row.key}
            value={
              row.value
                ? t('bots.tools.valueNew', 'New value')
                : t('bots.tools.valueSaved', 'Saved')
            }
            navigates
            disabled={!editable}
            onPress={open({ kind: 'secret', index })}
          />
        ))}
        {add(
          url
            ? t('bots.tools.addHeader', 'Add header')
            : t('bots.tools.addVariable', 'Add variable'),
          open({ kind: 'secret', index: null })
        )}
      </SettingsSection>
      {error || invalid ? (
        <SettingsNote error>{error ?? invalid}</SettingsNote>
      ) : url ? null : (
        <SettingsNote>{t('bots.tools.trust', 'Only add software you trust.')}</SettingsNote>
      )}
    </>
  )
}
