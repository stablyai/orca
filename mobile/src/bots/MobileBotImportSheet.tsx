// Import from another app, from New bot: pick a bot OpenClaw, Hermes or OpenBot keeps on the bot's computer, or
// the folder an old bot exported there; the new bot's first turn brings it over. The desktop's ImportBotDialog.
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ScrollView, Text, View, type HostInstance } from 'react-native'
import { Ellipsis, Plus } from 'lucide-react-native'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { TextField } from '../components/composer-input/TextField'
import { LIST_LEADING_INSET, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { MessageBox } from '../components/composer-input/MessageBox'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { triggerError } from '../platform/haptics/haptics'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { BOT_NAME_MAX_LENGTH } from '../../../src/shared/bot-types'
import { botInitial } from '../../../src/shared/bots/bot-avatar-fallback'
import {
  BOT_IMPORT_APP_LABELS,
  BOT_IMPORT_EXPORT_PROMPT,
  BOT_IMPORT_REPLY_MAX,
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
import { groupFieldStyles } from './MobileNewBotPickers'

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
  /** Runs on and Agent, as New bot's rows, and the note under them. */
  pickerRows: readonly ReactElement[]
  pickerNote: ReactNode
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
  // Make a new bot instead: a pick imported before names another bot rather than updating it.
  const [copying, setCopying] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef<HostInstance>(null)
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
  const imported = pick?.bot.importedAs ?? null
  const madeBefore = imported ? (props.bots.find((bot) => bot.id === imported.botId) ?? null) : null
  // The bot an earlier import made gets the new things, instead of a second bot; one this sheet
  // can't open is imported again under a new name.
  const again = imported && madeBefore && props.onUpdate && !copying ? imported : null
  const existing = again ? madeBefore : null
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
      setCopying(false)
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
                setCopying(false)
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
          ? {
              trailingButtons: (
                <NavBarButton
                  ref={menuAnchor}
                  icon={Ellipsis}
                  accessibilityLabel={t('bots.import.more', 'More actions')}
                  onPress={() => setMenuOpen(true)}
                />
              )
            }
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
        {exporting ? (
          <MobileBotImportExportSteps
            noneFound={nothingFound && read.status === 'ready'}
            copied={copied}
            onCopy={copy}
            folder={folder}
            onRemoveFolder={() => setFolder(null)}
            onChooseFolder={props.client ? () => pager.open('folder') : null}
          />
        ) : (
          pickList
        )}
        {again ? null : (
          <SettingsSection>
            <TextField
              key="name"
              value={name}
              onChangeText={setTypedName}
              placeholder={
                pick?.bot.importedAs
                  ? t('bots.import.nameAnother', 'Name a new bot')
                  : t('bots.new.namePlaceholder', 'Name your bot')
              }
              maxLength={BOT_NAME_MAX_LENGTH}
              autoFocus={copying}
              autoCorrect={false}
              returnKeyType="done"
              style={groupFieldStyles.line}
            />
            {exporting && folder ? (
              <MessageBox
                key="reply"
                value={reply}
                onChangeText={setReply}
                maxLength={BOT_IMPORT_REPLY_MAX}
                placeholder={t('bots.import.replyPlaceholder', 'Paste its reply, if it wrote one')}
                accessibilityLabel={t('bots.import.replyLabel', 'Its reply')}
                style={groupFieldStyles.lines}
              />
            ) : null}
            {props.pickerRows}
          </SettingsSection>
        )}
        {again ? null : props.pickerNote}
        {read.status === 'failed' ? (
          <SettingsNote error>
            {t('bots.list.updateOrcaOn', 'Update Orca on {{host}}', { host: props.hostLabel })}
          </SettingsNote>
        ) : null}
        {props.error ? <SettingsNote error>{props.error}</SettingsNote> : null}
        {again ? null : (
          <SettingsNote>{t('bots.import.keysStay', 'Keys and logins stay behind')}</SettingsNote>
        )}
      </ScrollView>
      {again ? (
        <View style={styles.foot}>
          <SheetPrimaryButton
            label={t('bots.import.update', 'Update {{bot}}', { bot: again.name })}
            disabled={!update}
            onPress={() => update?.()}
          />
        </View>
      ) : null}
      <PullDownMenu
        visible={menuOpen && again !== null}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[
          [
            {
              label: t('bots.import.makeNew', 'Make a new bot instead'),
              icon: Plus,
              closeBeforePress: true,
              onPress: () => {
                setTypedName(null)
                setCopying(true)
              }
            }
          ]
        ]}
      />
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
  count: { fontSize: 13, color: colors.textMuted },
  foot: { paddingTop: spacing.md }
}))
