import { useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { BOT_TAKE_OVER_GOAL_MAX } from '../../../../src/shared/bots/bot-take-over'
import { sortBotsBySidebarOrder, type BotHomeOwner } from '../../../../src/shared/bots/bot-homes'
import { MessageBox } from '../../components/composer-input/MessageBox'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { getWorktreeRowIdentity } from '../../worktree/row-presentation/worktree-host-row-identity'
import { MobileBotAvatar } from '../../bots/MobileBotAvatar'
import { mobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import type { ListedHostBots } from '../../bots/host-bot-listing'
import type { ListedBot } from '../../bots/host-bots-operations'
import { useBotPurposes } from '../../bots/use-bot-purposes'
import {
  handToBotFailureLine,
  handToBotName,
  handToBotOwner,
  handWorkspaceToBot
} from './hand-to-bot-operations'

/** Where the picker picks up again: after New bot…, with the goal kept, and the made bot picked when
 *  its hand-over failed. */
export type HandToBotSeed = {
  goal: string
  /** A bot made here for this workspace: it is picked, and a retry tells it in its Home. */
  made?: { bot: ListedBot; failure: string }
}

// The host sends each bot's sidebar order loosely, so the desktop's order applies here too.
type SortableBot = ListedBot & Pick<BotHomeOwner, 'sidebarOrder' | 'createdAt'>

// Swapped into the workspace menu's open drawer, as the desktop's Hand to bot… dialog.
export function WorkspaceHandToBotSheet({
  row,
  rows,
  listing,
  client,
  seed,
  onBusy,
  onNewBot,
  onHandedOver,
  onClose
}: {
  row: Worktree
  rows: readonly Worktree[]
  listing: ListedHostBots
  client: RpcClient
  seed: HandToBotSeed | null
  onBusy: (busy: boolean) => void
  onNewBot: (goal: string) => void
  onHandedOver: (bot: ListedBot, sessionId: string) => void
  onClose: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const made = seed?.made?.bot
  const [goal, setGoal] = useState(seed?.goal ?? '')
  const [pickedId, setPickedId] = useState<string | null>(made?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(seed?.made?.failure ?? null)
  const purposes = useBotPurposes(client)
  // A bot just made may not be listed yet.
  const bots = sortBotsBySidebarOrder<SortableBot>(
    made && !listing.bots.some((bot) => bot.id === made.id) ? [made, ...listing.bots] : listing.bots
  )
  // Its placement as last read, so the owner and a put-back follow a move made since the menu opened.
  const current =
    rows.find((entry) => getWorktreeRowIdentity(entry) === getWorktreeRowIdentity(row)) ?? row
  const owner = handToBotOwner(current, rows, bots)
  const picked = bots.find((bot) => bot.id === pickedId) ?? null
  const name = handToBotName(row)
  const count = row.agents?.length ?? 0

  const handOver = async () => {
    if (!picked || busy) {
      return
    }
    // A bot made here hears of it in its Home, as on the first try.
    const chat = picked.id === made?.id ? 'home' : 'new'
    setBusy(true)
    onBusy(true)
    setFailure(null)
    const outcome = await handWorkspaceToBot({ client, row: current, bot: picked, chat, goal })
    setBusy(false)
    onBusy(false)
    if (outcome.ok) {
      onHandedOver(picked, outcome.sessionId)
      return
    }
    setFailure(handToBotFailureLine(outcome, name, picked.name))
  }

  return (
    <View>
      <SheetHeader
        titleAboveActions
        title={t('bots.handToBot.title', 'Hand {{name}} to a bot', { name })}
        subtitle={
          count === 0
            ? t('bots.handToBot.noAgents', 'It has no agents running.')
            : count === 1
              ? t('bots.handToBot.oneAgent', 'Its agent keeps running and works for the bot.')
              : t('bots.handToBot.agents', 'Its {{n}} agents keep running and work for the bot.', {
                  n: count
                })
        }
        leading={{ label: t('common.cancel', 'Cancel'), onPress: onClose, disabled: busy }}
      />
      <ScrollView style={styles.bots}>
        <ListGroup>
          <ListRow
            title={t('bots.handToBot.newBot', 'New bot…')}
            subtitle={t('bots.handToBot.newBotNote', 'Set one up for this workspace')}
            leading={
              <View style={styles.newTile}>
                <Plus size={16} color={colors.textSecondary} />
              </View>
            }
            navigates
            disabled={busy}
            onPress={() => onNewBot(goal)}
          />
          {bots.map((bot) => {
            const has = owner?.id === bot.id
            return (
              <ListRow
                key={bot.id}
                title={bot.name}
                subtitle={purposes.get(bot.id)}
                subtitleLines={1}
                leading={
                  <MobileBotAvatar
                    avatar={mobileBotAvatarSource(bot, listing.avatarUris.get(bot.id))}
                    size={28}
                  />
                }
                value={has ? t('bots.handToBot.hasIt', 'Has it now') : undefined}
                selected={bot.id === pickedId}
                accessibilityRole="radio"
                disabled={has || busy}
                onPress={() => setPickedId(bot.id)}
              />
            )
          })}
        </ListGroup>
      </ScrollView>
      <SectionHeader
        title={`${t('bots.handToBot.goal', 'What should it do with this?')} ${t('bots.handToBot.optional', '(optional)')}`}
      />
      <MessageBox
        value={goal}
        onChangeText={setGoal}
        maxLength={BOT_TAKE_OVER_GOAL_MAX}
        autoComplete="off"
        placeholder={t('bots.handToBot.goalPlaceholder', 'e.g. get it merged by Friday')}
        editable={!busy}
      />
      {owner && picked ? (
        <Text style={styles.note}>
          {t(
            'bots.handToBot.moveNote',
            '{{owner}} has this workspace now. Handing it over moves it, and its agents, to {{bot}}.',
            { owner: owner.name, bot: picked.name }
          )}
        </Text>
      ) : null}
      {failure ? (
        <Text style={styles.failure} accessibilityRole="alert">
          {failure}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <SheetPrimaryButton
          label={
            owner && picked
              ? t('bots.handToBot.moveTo', 'Move to {{bot}}', { bot: picked.name })
              : t('bots.handToBot.handOver', 'Hand over')
          }
          busy={busy}
          disabled={!picked}
          onPress={() => void handOver()}
        />
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bots: { maxHeight: 300 },
  newTile: {
    width: 28,
    height: 28,
    borderRadius: radii.tile,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.inputBorder,
    alignItems: 'center',
    justifyContent: 'center'
  },
  note: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md
  },
  failure: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md
  },
  footer: { marginTop: spacing.xl }
}))
