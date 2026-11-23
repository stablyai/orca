import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Shuffle } from '../components/icons/app-icons'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { TextField } from '../components/composer-input/TextField'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerError } from '../platform/haptics/haptics'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  isBotMascotId,
  mascotAvatar,
  parseBotAvatar,
  randomMascotAvatar
} from '../../../src/shared/bot-avatar'
import { proposalCreateParams, type BotProposal } from '../../../src/shared/bots/bot-proposal'
import { botTemplate } from '../../../src/shared/bots/bot-templates'
import { botTemplateWord } from '../../../src/shared/bots/bot-template-text'
import { MobileBotTemplatesSheet } from './MobileBotTemplatesSheet'
import { MobileBotImportSheet, type BotImportFrom } from './MobileBotImportSheet'
import { MobileBotShareReceiveSheet } from './sharing/MobileBotShareReceiveSheet'
import { useBotImportSources } from './bot-import-host-reads'
import { botImportNudge } from '../../../src/shared/bots/bot-import'
import { BOT_NAME_MAX_LENGTH, type BotAgent } from '../../../src/shared/bot-types'
import { botCreate } from './bot-sheet-operations'
import type { ListedBot, PhoneBot } from './host-bots-operations'
import { MobileBotAvatar } from './MobileBotAvatar'
import type { NewBotComputer } from './new-bot-computers'
import {
  NewBotAgentRow,
  NewBotAgentSheet,
  NewBotComputerSheet,
  NewBotRunsOn,
  useNewBotAgentChoices,
  useOtherOrcaAccount
} from './MobileNewBotPickers'

type NewBotSheetProps = {
  visible: boolean
  /** The computer it starts on, by `NewBotComputer.id`; Runs on changes it. */
  computerId: string | null
  /** Runs on's choices: this computer, then each server. */
  computers: readonly NewBotComputer[]
  /** The bots on a computer now, so a template's name is free there ("Pull request review 2"), and a
   *  link one was made from offers that bot. */
  botsOn: (computerId: string) => readonly ListedBot[]
  /** Opens a bot already made from a pasted link or an earlier import, `homeDraft` in its Home Chat;
   *  absent, From a link doesn't show. */
  onOpenBot?: (bot: ListedBot, computer: NewBotComputer, homeDraft?: string) => void
  /** The route to a computer's bots.create; null once it can't be reached. */
  clientFor: (computerId: string) => RpcClient | null
  /** The route to the paired computer that reaches it, whose Orca account a server's is compared with. */
  pairedClientFor: (computerId: string) => RpcClient | null
  onClose: () => void
  /** The form's drawer finished closing, when a picker hasn't replaced it. */
  onAfterClose?: () => void
  /** The bot the computer made; its Home opens next, where it speaks first. */
  onCreated: (bot: PhoneBot, computer: NewBotComputer) => void
  /** A filled-in form, on a computer it pins: an offer card's proposal, whose bot answers that card,
   *  or Hand to bot's, whose bot takes the workspace over. */
  seed?: {
    proposal: BotProposal
    /** The proposer's agent; absent when this build doesn't know it, so the owner picks one. */
    agent?: BotAgent
    fromOffer?: { botId: string; offerId: string }
    /** Its first turn is the hand-over, sent once the workspace moved. */
    takingOver?: true
    /** "Proposed by …" under the title. */
    origin: string
  }
}

/** New bot from the Bots list: the desktop dialog's picture, name, agent and computer. Each opening
 *  gets its own form, so a template picked and cancelled never carries into the next New bot, and a
 *  late answer lands on a form that is gone. */
export function MobileNewBotSheet(props: NewBotSheetProps) {
  const [form, setForm] = useState({ open: props.visible, key: 0 })
  if (form.open !== props.visible) {
    setForm({ open: props.visible, key: props.visible ? form.key + 1 : form.key })
  }
  return <NewBotForm key={form.key} {...props} />
}

function NewBotForm(props: NewBotSheetProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { seed } = props
  const [name, setName] = useState(seed?.proposal.name ?? '')
  const [computerId, setComputerId] = useState(props.computerId)
  const [picked, setPicked] = useState<BotAgent>(seed?.agent ?? 'claude')
  const [avatar, setAvatar] = useState(() =>
    seed?.proposal.mascot && isBotMascotId(seed.proposal.mascot)
      ? mascotAvatar(seed.proposal.mascot)
      : randomMascotAvatar(null)
  )
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // From a template: its purpose seeds the bot's SOUL.md.
  const [proposal, setProposal] = useState<{ value: BotProposal; origin: string } | null>(
    seed ? { value: seed.proposal, origin: seed.origin } : null
  )
  const [picking, setPicking] = useState<'template' | 'computer' | 'agent' | null>(null)
  // While the computer makes the bot the form stays as it is, as the desktop dialog does.
  const pick = (next: 'template' | 'computer' | 'agent') => {
    if (!creating) {
      setPicking(next)
    }
  }
  // Import from another app stays under the computer and agent pickers it opens.
  const [importing, setImporting] = useState(false)
  // From a link stays under the computer and agent pickers it opens.
  const [receiving, setReceiving] = useState(false)
  const listed = props.computers.find((entry) => entry.id === computerId)
  // A chosen computer that drops out keeps its name, unreachable, so Runs on can move the draft.
  const [lastChosen, setLastChosen] = useState(listed)
  if (listed && listed !== lastChosen) {
    setLastChosen(listed)
  }
  const computer = listed ?? (computerId === lastChosen?.id ? lastChosen : undefined)
  const client = listed && listed.refusal === undefined ? props.clientFor(listed.id) : null
  const choices = useNewBotAgentChoices(client)
  const importRead = useBotImportSources(seed ? null : client)
  const nudge = importRead.status === 'ready' ? botImportNudge(importRead.sources) : null
  // The kept agent moves to the computer's first when it lacks it; until it answers, the kept one shows.
  const agent = choices?.length && !choices.includes(picked) ? choices[0] : picked
  const otherAccount = useOtherOrcaAccount(
    computer?.hostId.startsWith('runtime:') ? client : null,
    computer ? props.pairedClientFor(computer.id) : null
  )
  // Runs on shows when there is another computer to pick, and, locked, for a seed's pinned one.
  const choosesComputer = props.computers.length > 1 || seed !== undefined || !listed
  const picture = parseBotAvatar(avatar)
  const trimmed = name.trim()
  const template = botTemplate(proposal?.value.templateId)
  // Until the computer says which agents it has, or when it has none, it makes no bot, as the desktop's New bot.
  const agentsReady = client !== null && choices !== null && choices.length > 0
  const ready = trimmed.length > 0 && agentsReady

  // An import names its bot on its own page.
  const create = async (imported?: { name: string; importFrom: BotImportFrom }) => {
    if (!(imported ? agentsReady : ready) || creating || !client || !computer) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      const { bot } = botCreate.interpret(
        await botCreate.request(
          client,
          imported
            ? { name: imported.name, agent, avatar, importFrom: imported.importFrom }
            : {
                // A workspace with no note or branch words seeds no purpose: a plain bot, as on the desktop.
                ...(proposal?.value.purpose.trim()
                  ? proposalCreateParams({ ...proposal.value, name: trimmed }, agent, {
                      templatePackages: computer?.templatePackages === true,
                      templateNameShown: template
                        ? botTemplateWord(template, 'name', t)
                        : undefined,
                      ...(seed?.fromOffer ? { fromOffer: seed.fromOffer } : {})
                    })
                  : { name: trimmed, agent }),
                avatar,
                ...(seed?.takingOver ? { takingOver: true as const } : {})
              }
        )
      )
      setName('')
      setProposal(null)
      setAvatar(randomMascotAvatar(null))
      props.onCreated(bot, computer)
    } catch (error) {
      triggerError()
      setError(
        error instanceof Error ? error.message : t('bots.new.failed', 'Couldn’t create the bot')
      )
    } finally {
      setCreating(false)
    }
  }

  const leaveImport = () => {
    setError(null)
    setImporting(false)
  }
  const pictureView = (
    <View>
      {picture?.kind === 'mascot' ? (
        <MobileBotAvatar avatar={{ kind: 'mascot', id: picture.id }} size={72} />
      ) : null}
      <Pressable
        style={({ pressed }) => [styles.shuffle, pressed && styles.pressed]}
        onPress={() => setAvatar(randomMascotAvatar(avatar))}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('bots.new.shuffle', 'Another picture')}
      >
        <Shuffle size={14} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
  const runsOn = choosesComputer ? (
    <NewBotRunsOn
      computer={computer}
      locked={seed !== undefined || Boolean(proposal?.value.worktrees?.length)}
      reachable={client !== null}
      otherAccount={otherAccount}
      onPick={() => pick('computer')}
    />
  ) : null
  const agentRow = (
    <NewBotAgentRow
      agent={choices?.length === 0 ? null : agent}
      hostLabel={computer?.label ?? ''}
      loading={client !== null && choices === null}
      onPick={() => pick('agent')}
    />
  )

  return (
    // iOS cannot present over a closing sibling Modal; the form and its pickers share one.
    <BottomDrawerModalHost>
      <MobileBotTemplatesSheet
        visible={props.visible && picking === 'template'}
        botNames={
          picking === 'template' && computer ? props.botsOn(computer.id).map((bot) => bot.name) : []
        }
        onClose={() => setPicking(null)}
        onPick={(pick) => {
          setPicking(null)
          if ('blank' in pick) {
            setProposal(null)
            return
          }
          setProposal({ value: pick.proposal, origin: pick.origin })
          setName(pick.proposal.name)
          if (pick.proposal.mascot) {
            setAvatar(mascotAvatar(pick.proposal.mascot))
          }
        }}
      />
      <NewBotComputerSheet
        visible={props.visible && picking === 'computer'}
        computers={props.computers}
        chosen={computerId}
        onPick={setComputerId}
        onClose={() => setPicking(null)}
      />
      <NewBotAgentSheet
        visible={props.visible && picking === 'agent'}
        hostLabel={computer?.label ?? ''}
        agents={choices?.length ? choices : [agent]}
        chosen={agent}
        onPick={setPicked}
        onClose={() => setPicking(null)}
      />
      <MobileBotImportSheet
        // A folder or pick from one computer never goes to another.
        key={computerId ?? ''}
        visible={props.visible && importing && picking === null}
        hostLabel={computer?.label ?? ''}
        client={client}
        read={importRead}
        picture={pictureView}
        runsOn={
          <>
            {runsOn}
            {agentRow}
          </>
        }
        ready={agentsReady}
        bots={computer ? props.botsOn(computer.id) : []}
        onUpdate={
          props.onOpenBot && computer
            ? (bot, draft) => props.onOpenBot?.(bot, computer, draft)
            : null
        }
        creating={creating}
        error={error}
        onBack={leaveImport}
        onClose={leaveImport}
        onAfterClose={props.onAfterClose}
        onCreate={(importName, importFrom) => void create({ name: importName, importFrom })}
      />
      {props.onOpenBot ? (
        <MobileBotShareReceiveSheet
          visible={props.visible && receiving && picking === null}
          client={client}
          bots={computer ? props.botsOn(computer.id) : []}
          agent={agent}
          runsOn={
            <>
              {runsOn}
              {agentRow}
            </>
          }
          ready={agentsReady}
          onBack={() => setReceiving(false)}
          onClose={props.onClose}
          onAfterClose={props.onAfterClose}
          onCreated={(bot) => computer && props.onCreated(bot, computer)}
          onOpenBot={(bot) => computer && props.onOpenBot?.(bot, computer)}
        />
      ) : null}
      <BottomDrawer
        visible={props.visible && !importing && !receiving && picking === null}
        dismissible={!creating}
        onClose={props.onClose}
        onAfterClose={props.onAfterClose}
      >
        <SheetHeader
          titleAboveActions
          title={t('bots.new.title', 'New bot')}
          {...(proposal || !choosesComputer
            ? {
                subtitle: proposal
                  ? proposal.origin
                  : t('bots.new.runsOnHost', 'Runs on {{host}}.', { host: computer?.label ?? '' })
              }
            : {})}
          leading={{
            label: t('common.cancel', 'Cancel'),
            onPress: props.onClose,
            disabled: creating
          }}
          trailing={{
            label: t('bots.new.create', 'Create'),
            onPress: () => void create(),
            disabled: !ready,
            busy: creating
          }}
        />
        {proposal ? null : (
          <ListGroup style={styles.templateGroup}>
            <ListRow
              key="template"
              title={t('bots.new.fromTemplate', 'Use template')}
              navigates
              onPress={() => pick('template')}
            />
            {/* Only a computer that lists other apps' bots takes `importFrom`; an older one drops it. */}
            {importRead.status !== 'ready' ? null : (
              <ListRow
                key="import"
                title={t('bots.import.title', 'Import from another app')}
                {...(nudge
                  ? {
                      subtitle:
                        nudge.count === 1
                          ? t('bots.import.nudgeOne', 'We found a bot in {{app}}.', {
                              app: nudge.label
                            })
                          : t('bots.import.nudgeMany', 'We found {{count}} bots in {{app}}.', {
                              count: nudge.count,
                              app: nudge.label
                            })
                    }
                  : {})}
                navigates
                onPress={() => {
                  if (!creating) {
                    setError(null)
                    setImporting(true)
                  }
                }}
              />
            )}
            {props.onOpenBot && !seed ? (
              <ListRow
                key="link"
                title={t('bots.share.receive.fromLink', 'From a link')}
                subtitle={t('bots.share.receive.pasteDescription', 'Paste a link someone shared.')}
                navigates
                onPress={() => {
                  if (!creating) {
                    setReceiving(true)
                  }
                }}
              />
            ) : null}
          </ListGroup>
        )}
        {runsOn}
        <View style={styles.picture}>{pictureView}</View>
        <TextField
          value={name}
          onChangeText={setName}
          placeholder={t('bots.new.namePlaceholder', 'Name your bot')}
          maxLength={BOT_NAME_MAX_LENGTH}
          autoFocus
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void create()}
        />
        {proposal?.value.worktrees?.length ? (
          <Text style={styles.takesOver}>
            {t('bots.new.takesOverList', 'Takes over {{names}}. Their agents keep running.', {
              names: proposal.value.worktrees.map((entry) => entry.name).join(', ')
            })}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {agentRow}
      </BottomDrawer>
    </BottomDrawerModalHost>
  )
}

const styles = themedStyleSheet(() => ({
  picture: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md
  },
  shuffle: {
    position: 'absolute',
    right: -spacing.sm,
    bottom: -spacing.sm,
    padding: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  templateGroup: { marginBottom: spacing.md },
  takesOver: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm },
  error: { fontSize: 13, color: colors.statusRed, marginTop: spacing.sm },
  pressed: { opacity: 0.7 }
}))
