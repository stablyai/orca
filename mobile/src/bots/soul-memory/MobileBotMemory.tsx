// Settings › Memory: the desktop's BotMemoryPanel. What it knows lists MEMORY.md's facts with Quick add,
// Edit and Forget (swipe left, or tap to edit); History lists every change with Undo.
import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Text, View } from 'react-native'
import { FileText, History, Pencil, Plus, Trash2 } from 'lucide-react-native'
import {
  BOT_MEMORY_INDEX_LINE_CAP,
  type BotMemoryFact,
  botMemorySourceLink,
  countBotMemoryLines,
  findBotMemoryFact,
  parseBotMemoryFacts
} from '../../../../src/shared/bot-memory-lines'
import { TextField } from '../../components/composer-input/TextField'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsEmptyRow, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botMemoryEdit, botMemoryForget } from './bot-memory-operations'
import { MobileBotMemoryHistory } from './MobileBotMemoryHistory'
import type { BotMemoryTopic, BotMemoryTopics } from './use-bot-home-files'

// A file name, never translated.
const MEMORY_FILE = 'MEMORY.md'

/** One change on the host at a time; the file is read again after each. */
export type MemoryActions = {
  run: (change: (client: RpcClient) => Promise<void>) => Promise<boolean>
  busy: boolean
  showToast: (message: string) => void
}

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat(getUiIntlLocale(), { month: 'short', day: 'numeric' }).format(
    new Date(year, month - 1, day)
  )
}

function factMeta(t: ReturnType<typeof useMobileTranslation>, fact: BotMemoryFact) {
  const parts = [
    fact.date ? shortDate(fact.date) : null,
    fact.source
      ? t('bots.memory.source', 'From {{source}}', {
          source: botMemorySourceLink(fact.source).text
        })
      : null
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** A fact reworded, as a page of its own: sheets can't open over the bot's drawer. */
export function MobileBotMemoryEditPage(props: {
  botId: string
  fact: BotMemoryFact
  /** MEMORY.md as last read, to find the fact if the bot moved it meanwhile. */
  text: string
  disabled: boolean
  actions: MemoryActions
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const { actions, botId, fact } = props
  const [draft, setDraft] = useState(fact.text)
  const save = async () => {
    const saved = await actions.run(async (client) => {
      // A fact the bot removed meanwhile is saved as a new one, as on the desktop.
      const now = findBotMemoryFact(props.text, fact)
      botMemoryEdit.interpret(
        await botMemoryEdit.request(
          client,
          now ? { botId, fact: now.text, text: draft } : { botId, text: draft },
          { failWhenDisconnected: true }
        )
      )
    })
    if (saved) {
      props.onClose()
    }
  }
  return (
    <>
      <SheetHeader
        title={t('bots.memory.title', 'Memory')}
        leading={{ label: t('bots.memory.cancel', 'Cancel'), onPress: props.onClose }}
        trailing={{
          label: t('bots.memory.save', 'Save'),
          onPress: () => void save(),
          disabled: props.disabled || draft.trim() === '',
          busy: actions.busy
        }}
      />
      <TextField
        accessibilityLabel={t('bots.memory.fact', 'Memory')}
        value={draft}
        onChangeText={setDraft}
        multiline
        autoFocus
        editable={!actions.busy}
        style={styles.field}
      />
    </>
  )
}

function TopicRow(props: {
  topic: BotMemoryTopic
  icon: ReactNode
  onOpen: ((path: string) => void) | null
}) {
  const t = useMobileTranslation()
  const { name, lines } = props.topic
  const path = `memory/${name}`
  const onOpen = props.onOpen
  return (
    <ListRow
      leading={props.icon}
      title={path}
      subtitle={
        lines === null
          ? undefined
          : t('bots.memory.topicLines', '{{count}} lines', {
              count: lines,
              defaultValue_one: '{{count}} line'
            })
      }
      navigates={onOpen !== null}
      onPress={onOpen ? () => onOpen(path) : undefined}
    />
  )
}

/** The topic files, then the archive, each opening in the file viewer. */
function TopicFiles(props: {
  topics: BotMemoryTopics
  onOpenFile: ((path: string) => void) | null
}) {
  const t = useMobileTranslation()
  const { topics, archive } = props.topics
  const fileIcon = <FileText size={18} color={colors.textSecondary} strokeWidth={2} />
  const archiveIcon = <History size={18} color={colors.textSecondary} strokeWidth={2} />
  if (topics.length === 0 && !archive) {
    return null
  }
  return (
    <SettingsSection
      title={t('bots.memory.topicFiles', 'Topic files')}
      separatorInset={LIST_LEADING_INSET}
    >
      {topics.map((topic) => (
        <TopicRow key={topic.name} topic={topic} icon={fileIcon} onOpen={props.onOpenFile} />
      ))}
      {archive ? <TopicRow topic={archive} icon={archiveIcon} onOpen={props.onOpenFile} /> : null}
    </SettingsSection>
  )
}

function Facts(
  props: {
    botId: string
    text: string
    topics: BotMemoryTopics | null
    disabled: boolean
    actions: MemoryActions
    onEdit: (fact: BotMemoryFact) => void
    onOpenFile: ((path: string) => void) | null
  } & QuickAdd
) {
  const t = useMobileTranslation()
  const { botId, actions, quickAdd, setQuickAdd } = props
  const facts = parseBotMemoryFacts(props.text)
  const lines = countBotMemoryLines(props.text)
  const locked = props.disabled || actions.busy
  const add = async () => {
    const submitted = quickAdd
    const text = submitted.trim()
    if (locked || text === '') {
      return
    }
    const saved = await actions.run(async (client) => {
      botMemoryEdit.interpret(
        await botMemoryEdit.request(client, { botId, text }, { failWhenDisconnected: true })
      )
    })
    if (saved) {
      setQuickAdd((current) => (current === submitted ? '' : current))
    }
  }
  const forget = (fact: BotMemoryFact) =>
    void actions.run(async (client) => {
      botMemoryForget.interpret(
        await botMemoryForget.request(
          client,
          { botId, fact: fact.text },
          { failWhenDisconnected: true }
        )
      )
    })
  return (
    <>
      <TextField
        leading={<Plus size={18} color={colors.textMuted} strokeWidth={2} />}
        trailing={
          quickAdd.trim() ? (
            <MobileBotTextButton
              label={t('bots.memory.save', 'Save')}
              disabled={locked}
              onPress={() => void add()}
            />
          ) : undefined
        }
        accessibilityLabel={t('bots.memory.add', 'Add memory')}
        placeholder={t('bots.memory.addPlaceholder', 'Remember something new…')}
        value={quickAdd}
        onChangeText={setQuickAdd}
        editable={!props.disabled}
        returnKeyType="done"
        onSubmitEditing={() => void add()}
        style={styles.quickAdd}
      />
      <SectionHeader
        title={MEMORY_FILE}
        trailing={
          <View style={styles.gauge}>
            <Text style={styles.gaugeText}>
              {t('bots.memory.lines', '{{count}} / {{cap}} lines', {
                count: lines,
                cap: BOT_MEMORY_INDEX_LINE_CAP
              })}
            </Text>
            <View style={styles.gaugeTrack}>
              <View
                style={[
                  styles.gaugeFill,
                  { width: `${Math.min(100, (lines / BOT_MEMORY_INDEX_LINE_CAP) * 100)}%` }
                ]}
              />
            </View>
          </View>
        }
      />
      <ListGroup>
        {facts.length === 0 ? (
          <SettingsEmptyRow>{t('bots.memory.empty', 'No facts saved yet.')}</SettingsEmptyRow>
        ) : null}
        {facts.map((fact) => (
          <SwipeRowActions
            // A moved or changed fact remounts closed, so an open swipe never acts on another fact.
            key={`${fact.line}:${fact.date ?? ''}:${fact.text}`}
            enabled={!locked}
            trailing={[
              {
                label: t('bots.memory.edit', 'Edit'),
                accessibilityLabel: t('bots.memory.edit', 'Edit'),
                icon: Pencil,
                background: colors.textMuted,
                foreground: colors.onAccent,
                onPress: () => props.onEdit(fact)
              },
              {
                label: t('bots.memory.forget', 'Forget'),
                accessibilityLabel: t('bots.memory.forget', 'Forget'),
                icon: Trash2,
                background: colors.statusRed,
                foreground: colors.onStatusRed,
                onPress: () => forget(fact)
              }
            ]}
          >
            {(guardPress) => (
              <ListRow
                title={fact.text}
                wrapTitle
                subtitle={factMeta(t, fact)}
                disabled={props.disabled}
                busy={actions.busy}
                onPress={guardPress(() => props.onEdit(fact))}
              />
            )}
          </SwipeRowActions>
        ))}
      </ListGroup>
      {props.topics ? <TopicFiles topics={props.topics} onOpenFile={props.onOpenFile} /> : null}
    </>
  )
}

/** Quick add's text, kept by the page so it outlives a trip to edit a fact. */
type QuickAdd = { quickAdd: string; setQuickAdd: Dispatch<SetStateAction<string>> }

/** The Memory page, under its header, once MEMORY.md has been read. */
export function MobileBotMemoryBody(
  props: QuickAdd & {
    client: RpcClient | null
    botId: string
    text: string
    topics: BotMemoryTopics | null
    /** Offline: nothing can change. */
    disabled: boolean
    actions: MemoryActions
    onOpenFile: ((path: string) => void) | null
    onEdit: (fact: BotMemoryFact) => void
  }
) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [tab, setTab] = useState<'facts' | 'history'>('facts')
  const facts = parseBotMemoryFacts(props.text)
  return (
    <>
      <MobileSegmentedControl
        segments={[
          {
            value: 'facts',
            label: t('bots.memory.tabFacts', 'What it knows'),
            trailing:
              facts.length > 0 ? <Text style={styles.count}>{` ${facts.length}`}</Text> : undefined
          },
          { value: 'history', label: t('bots.memory.tabHistory', 'History') }
        ]}
        selected={tab}
        onSelect={setTab}
        fill
        onSheet
        tabs
        style={styles.tabs}
      />
      {tab === 'facts' ? (
        <Facts {...props} />
      ) : (
        <MobileBotMemoryHistory
          client={props.client}
          botId={props.botId}
          version={props.text}
          disabled={props.disabled || props.actions.busy}
          actions={props.actions}
        />
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  tabs: { marginTop: spacing.sm },
  count: { color: colors.textSecondary, fontWeight: '500' },
  quickAdd: { marginTop: spacing.md },
  field: { marginTop: spacing.sm, minHeight: 96 },
  gauge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  gaugeText: { fontSize: 13, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  gaugeTrack: {
    width: 40,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  gaugeFill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.textSecondary }
}))
