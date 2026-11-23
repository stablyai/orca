// Import from another app, from New bot: pick a bot OpenClaw, Hermes or OpenBot keeps on the bot's computer, or
// the folder an old bot exported there; the new bot's first turn brings it over. The desktop's ImportBotDialog.
import { useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Plus } from '../components/icons/app-icons'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { TextField } from '../components/composer-input/TextField'
import { LIST_LEADING_INSET, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { triggerError } from '../platform/haptics/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { BOT_NAME_MAX_LENGTH } from '../../../src/shared/bot-types'
import { botInitial } from '../../../src/shared/bots/bot-avatar-fallback'
import {
  BOT_IMPORT_APP_LABELS,
  BOT_IMPORT_EXPORT_PROMPT,
  botNameFromExportFolder,
  type BotImportCandidate,
  type BotImportSource
} from '../../../src/shared/bots/bot-import'
import type { BotCreateParams } from '../../../src/shared/rpc-contract/bots-params'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import type { BotImportSourcesRead } from './bot-import-host-reads'
import type { ListedBot } from './host-bots-operations'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotImportHero } from './MobileBotImportHero'
import { MobileBotExportFolderPage, type ExportFolder } from './MobileBotExportFolderPage'
import { MobileBotImportExportSteps } from './MobileBotImportExportSteps'

export type BotImportFrom = NonNullable<BotCreateParams['importFrom']>

type ImportPick = { source: BotImportSource; bot: BotImportCandidate }

const TILE = 28

function pickKey(pick: ImportPick): string {
  return `${pick.source.app}:${pick.bot.agent}`
}

export function MobileBotImportSheet(props: {
  visible: boolean
  hostLabel: string
  /** The route to the bot's computer, for its folders; null once it can't be reached. */
  client: RpcClient | null
  read: BotImportSourcesRead
  /** The new bot's picture, with its shuffle. */
  picture: ReactNode
  /** Runs on and Agent, as New bot shows them. */
  runsOn: ReactNode
  /** The computer is reachable and has said which agents it has. */
  ready: boolean
  /** The computer's bots, for the one an earlier import made. */
  bots: readonly ListedBot[]
  /** Opens that bot's Home Chat with `draft`; null where this sheet can't open a bot. */
  onUpdate: ((bot: ListedBot, draft: string) => void) | null
  creating: boolean
  error: string | null
  onBack: () => void
  onClose: () => void
  onAfterClose?: () => void
  onCreate: (name: string, importFrom: BotImportFrom) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const pager = useOptionPager<'folder'>()
  const [view, setView] = useState<'pick' | 'export'>('pick')
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  // Follows the picked bot, or the exported folder, until the owner types one.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [folder, setFolder] = useState<ExportFolder | null>(null)
  const [reply, setReply] = useState('')
  const [copied, setCopied] = useState(false)
  useBottomDrawerModalHostBackClaim(pager.page ? pager.close : null)
  useBackClaim(
    pager.page
      ? () => {
          pager.close()
          return true
        }
      : null
  )

  const { read } = props
  const picks =
    read.status === 'ready'
      ? read.sources.flatMap((source) => source.bots.map((bot) => ({ source, bot })))
      : []
  // With nothing found there is nothing to pick: straight to asking the old bot.
  const nothingFound = read.status !== 'loading' && picks.length === 0
  const exporting = view === 'export' || nothingFound
  const pick = exporting
    ? null
    : (picks.find((entry) => pickKey(entry) === pickedKey) ?? picks[0] ?? null)
  const suggestion = folder
    ? (botNameFromExportFolder(folder.path)?.slice(0, BOT_NAME_MAX_LENGTH) ?? '')
    : ''
  // A bot imported before starts unnamed, so a second import is a choice.
  const name =
    typedName ??
    (exporting
      ? suggestion
      : pick && !pick.bot.importedAs
        ? pick.bot.name.slice(0, BOT_NAME_MAX_LENGTH)
        : '')
  const trimmed = name.trim()
  const again = pick?.bot.importedAs && !trimmed ? pick.bot.importedAs : null
  // The bot an earlier import made gets the new things, instead of a second bot.
  const existing = again ? (props.bots.find((bot) => bot.id === again.botId) ?? null) : null
  const update =
    existing && pick && props.onUpdate
      ? () =>
          props.onUpdate?.(
            existing,
            t('bots.import.updateDraft', 'Bring over anything new from {{name}} in {{app}}.', {
              name: pick.bot.name,
              app: BOT_IMPORT_APP_LABELS[pick.source.app]
            })
          )
      : null
  const importFrom: BotImportFrom | null = exporting
    ? folder && {
        app: 'export',
        path: folder.path,
        name: trimmed,
        ...(reply.trim() ? { reply } : {})
      }
    : pick && {
        app: pick.source.app,
        path: pick.bot.absolutePath,
        agent: pick.bot.agent,
        name: pick.bot.name
      }
  const canCreate =
    props.ready && read.status === 'ready' && trimmed.length > 0 && importFrom !== null

  const oldName = exporting
    ? folder && (botNameFromExportFolder(folder.path) ?? getRuntimePathBasename(folder.path))
    : pick?.bot.name
  const oldLabel = exporting
    ? folder
      ? getRuntimePathBasename(folder.path)
      : t('bots.import.oldBot', 'Old bot')
    : pick
      ? BOT_IMPORT_APP_LABELS[pick.source.app]
      : t('bots.import.oldBot', 'Old bot')

  const back = () => {
    if (view === 'export' && picks.length > 0) {
      setTypedName(null)
      setView('pick')
    } else {
      props.onBack()
    }
  }
  const copy = () => {
    clipboard.writeText(BOT_IMPORT_EXPORT_PROMPT).then(
      () => setCopied(true),
      () => triggerError()
    )
  }

  const rowDetail = (entry: ImportPick) => {
    if (entry.bot.importedAs) {
      return t('bots.import.importedAs', 'imported before as {{bot}}', {
        bot: entry.bot.importedAs.name
      })
    }
    const kind =
      entry.source.app === 'hermes'
        ? entry.bot.agent === 'default'
          ? t('bots.import.defaultProfile', 'default profile')
          : t('bots.import.profile', 'profile')
        : t('bots.import.agent', 'agent')
    return t('bots.import.rowDetail', '{{app}} {{kind}}', {
      app: BOT_IMPORT_APP_LABELS[entry.source.app],
      kind
    })
  }

  const pickList = (
    <>
      <SectionHeader
        title={t('bots.import.bringOver', 'Bring over')}
        trailing={
          <Text style={styles.count}>
            {read.status === 'loading'
              ? t('bots.import.lookingOn', 'Looking on {{host}}…', { host: props.hostLabel })
              : t('bots.import.foundOn', '{{count}} found on {{host}}', {
                  count: picks.length,
                  host: props.hostLabel
                })}
          </Text>
        }
      />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {picks.map((entry) => {
          const key = pickKey(entry)
          return (
            <ListRow
              key={key}
              leading={
                <MobileBotAvatar
                  avatar={{ kind: 'text', text: botInitial(entry.bot.name) }}
                  size={TILE}
                />
              }
              title={entry.bot.name}
              subtitle={rowDetail(entry)}
              selected={pick !== null && key === pickKey(pick)}
              onPress={() => {
                setPickedKey(key)
                setTypedName(null)
              }}
            />
          )
        })}
        <ListRow
          key="other-app"
          leading={
            <View style={[styles.tile, styles.dashed]}>
              <Plus size={14} color={colors.textMuted} />
            </View>
          }
          title={t('bots.import.otherApp', 'Another app…')}
          subtitle={t('bots.import.otherAppNote', 'Your old bot copies its files for you')}
          navigates
          onPress={() => {
            setTypedName(null)
            setView('export')
          }}
        />
      </ListGroup>
    </>
  )

  const main = (
    <View style={styles.page}>
      <SheetHeader
        title={t('bots.import.title', 'Import from another app')}
        onBack={{ label: t('common.back', 'Back'), onPress: back }}
        {...(again
          ? {}
          : {
              trailing: {
                label: t('bots.new.create', 'Create'),
                onPress: () => importFrom && canCreate && props.onCreate(trimmed, importFrom),
                disabled: !canCreate,
                busy: props.creating
              }
            })}
      />
      <ScrollView
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <MobileBotImportHero
          oldName={oldName}
          oldLabel={oldLabel}
          picture={props.picture}
          existing={existing}
        />
        <Text style={styles.lead}>
          {exporting
            ? t(
                'bots.import.exportDescription',
                'Ask your old bot for a copy of itself, then give the copy to your new bot.'
              )
            : t('bots.import.description', 'Your new bot reads the old one and sets itself up.')}
        </Text>
        <TextField
          value={name}
          onChangeText={setTypedName}
          placeholder={
            again
              ? t('bots.import.nameAnother', 'Name a new bot')
              : t('bots.new.namePlaceholder', 'Name your bot')
          }
          maxLength={BOT_NAME_MAX_LENGTH}
          autoCorrect={false}
          returnKeyType="done"
        />
        {again ? (
          <Text style={styles.note}>
            {t('bots.import.importedBefore', '{{bot}} came from this bot', { bot: again.name })}
          </Text>
        ) : null}
        {exporting ? (
          <MobileBotImportExportSteps
            hostLabel={props.hostLabel}
            noneFound={nothingFound && read.status === 'ready'}
            copied={copied}
            onCopy={copy}
            folder={folder}
            onRemoveFolder={() => setFolder(null)}
            onChooseFolder={props.client ? () => pager.open('folder') : null}
            reply={reply}
            onReply={setReply}
          />
        ) : (
          pickList
        )}
        {again ? (
          <View style={styles.runsOn}>
            <SheetPrimaryButton
              label={t('bots.import.update', 'Update {{bot}}', { bot: again.name })}
              disabled={!update}
              onPress={() => update?.()}
            />
          </View>
        ) : (
          <View style={styles.runsOn}>{props.runsOn}</View>
        )}
        {read.status === 'failed' ? (
          <Text style={styles.error}>
            {t('bots.list.updateOrcaOn', 'Update Orca on {{host}}', { host: props.hostLabel })}
          </Text>
        ) : null}
        {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
        {again ? null : (
          <Text style={styles.foot}>
            {t('bots.import.keysStay', 'Keys and logins stay behind')}
          </Text>
        )}
      </ScrollView>
    </View>
  )

  return (
    <BottomDrawer
      visible={props.visible}
      onClose={props.onClose}
      onAfterClose={() => {
        pager.forget()
        props.onAfterClose?.()
      }}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      <OptionPager
        pager={pager}
        main={main}
        page={
          pager.page === 'folder' ? (
            <MobileBotExportFolderPage
              client={props.client}
              hostLabel={props.hostLabel}
              onBack={pager.close}
              onPick={(picked) => {
                setFolder(picked)
                pager.close()
              }}
            />
          ) : null
        }
        fill
      />
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: TILE / 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dashed: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderSubtle },
  lead: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md
  },
  count: { fontSize: 13, color: colors.textMuted },
  note: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  runsOn: { marginTop: spacing.md },
  error: { fontSize: 13, color: colors.statusRed, marginTop: spacing.sm },
  foot: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xs
  }
}))
