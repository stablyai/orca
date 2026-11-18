import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight, Shuffle } from 'lucide-react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { TextField } from '../components/composer-input/TextField'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerError } from '../platform/haptics/haptics'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
import { MobileBotTemplatesSheet } from './MobileBotTemplatesSheet'
import { BOT_NAME_MAX_LENGTH, type BotAgent } from '../../../src/shared/bot-types'
import { botCreate } from './bot-sheet-operations'
import type { PhoneBot } from './host-bots-operations'
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
  /** The bots on a computer now, so a template's name is free there ("Pull request review 2"). */
  botNamesOn: (computerId: string) => readonly string[]
  /** The route to a computer's bots.create; null once it can't be reached. */
  clientFor: (computerId: string) => RpcClient | null
  /** The route to the paired computer that reaches it, whose Orca account a server's is compared with. */
  pairedClientFor: (computerId: string) => RpcClient | null
  onClose: () => void
  /** The form's drawer finished closing, when a picker hasn't replaced it. */
  onAfterClose?: () => void
  /** The bot the computer made; its Home opens next, where it speaks first. */
  onCreated: (bot: PhoneBot, computer: NewBotComputer) => void
  /** Editing a bot's offer card: its proposal fills the form, on the computer its proposer runs on,
   *  and the bot it makes answers that card. */
  offer?: {
    proposal: BotProposal
    /** The proposer's agent; absent when this build doesn't know it, so the owner picks one. */
    agent?: BotAgent
    fromOffer: { botId: string; offerId: string }
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
  const { offer } = props
  const [name, setName] = useState(offer?.proposal.name ?? '')
  const [computerId, setComputerId] = useState(props.computerId)
  const [picked, setPicked] = useState<BotAgent>(offer?.agent ?? 'claude')
  const [avatar, setAvatar] = useState(() =>
    offer?.proposal.mascot && isBotMascotId(offer.proposal.mascot)
      ? mascotAvatar(offer.proposal.mascot)
      : randomMascotAvatar(null)
  )
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // From a template: its purpose seeds the bot's SOUL.md.
  const [proposal, setProposal] = useState<{ value: BotProposal; origin: string } | null>(
    offer ? { value: offer.proposal, origin: offer.origin } : null
  )
  const [picking, setPicking] = useState<'template' | 'computer' | 'agent' | null>(null)
  const listed = props.computers.find((entry) => entry.id === computerId)
  // A chosen computer that drops out keeps its name, unreachable, so Runs on can move the draft.
  const [lastChosen, setLastChosen] = useState(listed)
  if (listed && listed !== lastChosen) {
    setLastChosen(listed)
  }
  const computer = listed ?? (computerId === lastChosen?.id ? lastChosen : undefined)
  const client = listed && listed.refusal === undefined ? props.clientFor(listed.id) : null
  const choices = useNewBotAgentChoices(client)
  // The kept agent moves to the computer's first when it lacks it; until it answers, the kept one shows.
  const agent = choices?.length && !choices.includes(picked) ? choices[0] : picked
  const otherAccount = useOtherOrcaAccount(
    computer?.hostId.startsWith('runtime:') ? client : null,
    computer ? props.pairedClientFor(computer.id) : null
  )
  // Runs on shows when there is another computer to pick, and, locked, for an offer's pinned one.
  const choosesComputer = props.computers.length > 1 || offer !== undefined || !listed
  const picture = parseBotAvatar(avatar)
  const trimmed = name.trim()
  // Until the computer says which agents it has, or when it has none, it makes no bot, as the desktop's New bot.
  const canCreate =
    trimmed.length > 0 && !creating && client !== null && choices !== null && choices.length > 0

  const create = async () => {
    if (!canCreate || !client || !computer) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      const { bot } = botCreate.interpret(
        await botCreate.request(
          client,
          proposal
            ? {
                ...proposalCreateParams({ ...proposal.value, name: trimmed }, agent, {
                  templatePackages: computer?.templatePackages === true,
                  ...(offer ? { fromOffer: offer.fromOffer } : {})
                }),
                avatar
              }
            : { name: trimmed, agent, avatar }
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

  return (
    <>
      <MobileBotTemplatesSheet
        visible={props.visible && picking === 'template'}
        botNames={picking === 'template' && computer ? props.botNamesOn(computer.id) : []}
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
      <BottomDrawer
        visible={props.visible && picking === null}
        onClose={props.onClose}
        onAfterClose={props.onAfterClose}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{t('bots.new.title', 'New bot')}</Text>
          {proposal || !choosesComputer ? (
            <Text style={styles.message}>
              {proposal
                ? proposal.origin
                : t('bots.new.runsOnHost', 'Runs on {{host}}.', {
                    host: computer?.label ?? ''
                  })}
            </Text>
          ) : null}
        </View>
        {proposal ? null : (
          <Pressable
            style={({ pressed }) => [styles.templateRow, pressed && styles.pressed]}
            onPress={() => setPicking('template')}
            accessibilityRole="button"
          >
            <Text style={styles.templateText}>
              {t('bots.new.fromTemplate', 'Start from a template')}
            </Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        )}
        {choosesComputer ? (
          <NewBotRunsOn
            computer={computer}
            locked={offer !== undefined || Boolean(proposal?.value.worktrees?.length)}
            reachable={client !== null}
            otherAccount={otherAccount}
            onPick={() => setPicking('computer')}
          />
        ) : null}
        <View style={styles.picture}>
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
        <NewBotAgentRow
          agent={agent}
          loading={client !== null && choices === null}
          onPick={() => setPicking('agent')}
        />
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
            onPress={props.onClose}
          >
            <Text style={styles.cancelText}>{t('common.cancel', 'Cancel')}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.submitButton,
              pressed && styles.pressed,
              !canCreate && styles.submitDisabled
            ]}
            disabled={!canCreate}
            onPress={() => void create()}
            accessibilityRole="button"
          >
            <Text style={styles.submitText}>
              {creating ? t('bots.new.creating', 'Creating…') : t('bots.new.create', 'Create')}
            </Text>
          </Pressable>
        </View>
      </BottomDrawer>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  header: { paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  title: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  message: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
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
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.md
  },
  templateText: { fontSize: typography.bodySize, color: colors.textPrimary },
  takesOver: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm },
  error: { fontSize: 13, color: colors.statusRed, marginTop: spacing.sm },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  cancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  submitButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  pressed: { opacity: 0.7 },
  submitDisabled: { opacity: 0.4 },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  submitText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' }
}))
