// Custom server: one field takes a URL, a start command, an mcpServers block or `mcp add` lines. The
// host reads it (the phone ships no parser): a preview names what it found, and Add sends the text.
// A plain URL can carry headers, kept as names once saved.
import { useEffect, useState } from 'react'
import { Plus } from '../components/icons/app-icons'
import { botToolNameFrom, freeBotToolName } from '../../../src/shared/bot-tools'
import { createNonSecureContextUuid as createUuid } from '../../../src/shared/identifiers/non-secure-context-uuid'
import { ListRow, SectionHeader } from '../components/list/ListGroup'
import { TextField } from '../components/composer-input/TextField'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotToolValuePage } from '../bots/tools/MobileBotToolValuePage'
import { mcpServerAdd, mcpServerPreviewPaste, type PhoneMcpServer } from './mcp-server-operations'

/** A catalog app's address, its name, and headers it needs filled in (GitHub's token). */
export type McpCustomPreset = {
  source: string
  name: string
  headers: readonly { key: string; value: string }[]
}

type Header = { id: string; key: string; value: string }
type Preview = { name: string; transport: 'http' | 'command'; detail: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const PREVIEW_DELAY_MS = 250

/** What the host reads in the paste, once typing pauses; null until it answers for this text. */
function usePastePreview(client: RpcClient | null, typed: string): Preview[] | null {
  const [preview, setPreview] = useState<{ source: string; servers: Preview[] } | null>(null)
  useEffect(() => {
    if (!client || !typed) {
      return undefined
    }
    let live = true
    const timer = setTimeout(() => {
      void mcpServerPreviewPaste
        .request(client, { source: typed })
        .then((reply) => mcpServerPreviewPaste.interpret(reply).servers)
        // A paste it can't read previews as nothing; Add then says why.
        .catch(() => [])
        .then((servers) => live && setPreview({ source: typed, servers }))
    }, PREVIEW_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, typed])
  return preview?.source === typed ? preview.servers : null
}

export function MobileMcpCustomServerPage(props: {
  client: RpcClient | null
  hostName: string
  /** The host's server names, for the name a preset or a headed URL is saved under. */
  taken: ReadonlySet<string>
  preset?: McpCustomPreset
  online: boolean
  onCancel: () => void
  onAdded: (server: PhoneMcpServer) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [source, setSource] = useState(props.preset?.source ?? '')
  const [headers, setHeaders] = useState<Header[]>(() =>
    (props.preset?.headers ?? []).map((header) => ({ id: createUuid(), ...header }))
  )
  // The headers page, then one header on it (null index: a new one).
  const [editing, setEditing] = useState<{ index: number | null } | 'list' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackClaim(() => {
    if (editing !== null && editing !== 'list') {
      setEditing('list')
    } else if (editing === 'list') {
      setEditing(null)
    } else if (!saving) {
      props.onCancel()
    }
    return true
  })
  const typed = source.trim()
  const { preset, taken } = props
  const servers = usePastePreview(props.client, typed) ?? []
  const one = servers.length === 1 ? servers[0] : null
  // Headers go with a plain URL; a pasted block carries its own.
  const url = /^https?:\/\/\S+$/i.test(typed)
  const name = preset
    ? freeBotToolName(preset.name, taken)
    : (one?.name ?? (url ? freeBotToolName(botToolNameFrom(typed), taken) : ''))
  const sent = url ? headers.filter((header) => header.key.trim()) : []
  // A preset's header still at its preset value ("Bearer ") has no token in it yet.
  const unfilled = (header: Header) =>
    header.value.trim() === '' ||
    preset?.headers.some((given) => given.key === header.key && given.value === header.value) ===
      true
  const missing = sent.find(unfilled)
  const add = () => {
    if (!props.client || !typed || saving || !props.online || missing) {
      return
    }
    setSaving(true)
    setError(null)
    const params =
      sent.length > 0
        ? {
            config: {
              name,
              url: typed,
              transport: 'http' as const,
              headers: sent.map(({ key, value }) => ({ key: key.trim(), value }))
            }
          }
        : preset
          ? { source: typed, name }
          : { source: typed }
    void mcpServerAdd
      .request(props.client, params, { failWhenDisconnected: true })
      .then((reply) => props.onAdded(mcpServerAdd.interpret(reply).server))
      .catch((caught: unknown) => {
        setSaving(false)
        setError(messageOf(caught))
      })
  }
  const back = {
    label: t('mcpServers.customServer', 'Custom server'),
    onPress: () => setEditing(null)
  }
  if (editing !== null && editing !== 'list') {
    const index = editing.index
    const row = index === null ? null : headers[index]
    return (
      <MobileBotToolValuePage
        title={t('mcpServers.header', 'Header')}
        initial={[row?.key ?? '', row?.value ?? '']}
        fields={() => [
          { label: t('mcpServers.headerName', 'Name'), required: true, maxLength: 256 },
          {
            label: t('mcpServers.headerValue', 'Value'),
            secret: true,
            required: true,
            maxLength: 4096
          }
        ]}
        remove={
          index === null
            ? undefined
            : {
                label: t('mcpServers.removeHeader', 'Remove header'),
                onPress: () => {
                  setHeaders(headers.filter((_, at) => at !== index))
                  setEditing('list')
                }
              }
        }
        onCancel={() => setEditing('list')}
        onDone={([key, value]) => {
          const next = { id: row?.id ?? createUuid(), key: key.trim(), value }
          setHeaders(
            index === null ? [...headers, next] : headers.map((h, at) => (at === index ? next : h))
          )
          setEditing('list')
        }}
      />
    )
  }
  if (editing === 'list') {
    return (
      <>
        <SheetHeader title={t('mcpServers.headers', 'Headers')} onBack={back} />
        <SettingsSection first>
          {headers.map((header, index) => (
            <ListRow
              key={header.id}
              title={header.key}
              value={unfilled(header) ? t('mcpServers.headerEmpty', 'Empty') : '••••••'}
              navigates
              onPress={() => setEditing({ index })}
            />
          ))}
          <ListRow
            key="add"
            title={t('mcpServers.addHeader', 'Add header')}
            leading={<Plus size={18} color={colors.textMuted} />}
            onPress={() => setEditing({ index: null })}
          />
        </SettingsSection>
      </>
    )
  }
  return (
    <>
      <SheetHeader
        title={t('mcpServers.customServer', 'Custom server')}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel, disabled: saving }}
        trailing={{
          label: t('mcpServers.addButton', 'Add'),
          onPress: add,
          disabled: !typed || !props.online || missing !== undefined,
          busy: saving
        }}
      />
      <SectionHeader title={t('mcpServers.sourceLabel', 'Server URL or start command')} first />
      <TextField
        monospace
        value={source}
        onChangeText={(next) => {
          setSource(next)
          setError(null)
        }}
        placeholder={t('mcpServers.sourcePlaceholder', 'https://… or npx …')}
        accessibilityLabel={t('mcpServers.sourceLabel', 'Server URL or start command')}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={!props.preset}
        multiline={/^\s*[{"]/.test(source)}
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      <SettingsNote error={error !== null}>
        {error ??
          t(
            'mcpServers.sourceNote',
            'Paste a server URL, a start command or an mcpServers config.'
          )}
      </SettingsNote>
      {servers.length > 0 || url ? (
        <SettingsSection
          title={t('mcpServers.details', 'Details')}
          footer={
            missing ? (
              <SettingsNote>
                {t('mcpServers.headerMissing', 'Fill in {{header}} to add this server.', {
                  header: missing.key
                })}
              </SettingsNote>
            ) : (
              t('mcpServers.trust', 'Only add software you trust.')
            )
          }
        >
          {servers.length <= 1 ? (
            <ListRow
              key="type"
              title={t('mcpServers.serverType', 'Server type')}
              value={
                one?.transport === 'command'
                  ? t('mcpServers.commandMode', 'Run a command')
                  : t('mcpServers.urlMode', 'Connect to a URL')
              }
            />
          ) : null}
          {servers.length <= 1 ? (
            <ListRow key="name" title={t('mcpServers.serverName', 'Server name')} value={name} />
          ) : (
            <ListRow
              key="servers"
              title={t('mcpServers.servers', 'Servers')}
              subtitle={servers.map((server) => server.name).join(', ')}
              subtitleLines={3}
            />
          )}
          {url ? (
            <ListRow
              key="headers"
              title={t('mcpServers.headers', 'Headers')}
              value={
                sent.length === 0
                  ? t('mcpServers.headersNone', 'None')
                  : sent.map((header) => header.key).join(', ')
              }
              navigates
              disabled={saving}
              onPress={() => setEditing('list')}
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  )
}
