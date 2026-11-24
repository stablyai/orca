// New bot from a reviewed link: New bot's picture, name, computer and agent, plus the permission (Ask, picked
// for bots made from a link) and the review's tool ticks. Create writes the reviewed version whole.
import { useState, type ReactElement, type ReactNode } from 'react'
import { View } from 'react-native'
import { isBotMascotId, mascotAvatar, randomMascotAvatar } from '../../../../src/shared/bot-avatar'
import { BOT_NAME_MAX_LENGTH, type BotAgent } from '../../../../src/shared/bot-types'
import { freeBotName } from '../../../../src/shared/bots/bot-template-view'
import { TextField } from '../../components/composer-input/TextField'
import { ListGroup, SectionHeader } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ChoiceRows, DrillRow } from '../../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError } from '../../platform/haptics/haptics'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botCreate } from '../bot-sheet-operations'
import type { ListedBot, PhoneBot } from '../host-bots-operations'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import { groupFieldStyles, NewBotPicture } from '../MobileNewBotPickers'
import { botShareErrorMessage } from './bot-share-copy'
import { botShareMoved, type PhoneShareReview } from './bot-share-receive-operations'
import { ReviewToolTicks } from './MobileBotShareReview'
import { reviewAvatar } from './bot-share-review-avatar'
import { shareListTitle } from './mobile-share-pages'

type SharedBotPermission = 'ask' | 'full-access' | 'chats'

/** What the owner changed on New bot; kept above the drawer, which unmounts under a picker. */
export type ShareCreateDraft = {
  name: string | null
  /** A shuffled mascot; null keeps the shared picture. */
  avatar: string | null
  permission: SharedBotPermission
  /** Create is out; kept here too, so a picker opened meanwhile can't send a second one. */
  creating: boolean
}

export const EMPTY_SHARE_CREATE_DRAFT: ShareCreateDraft = {
  name: null,
  avatar: null,
  permission: 'ask',
  creating: false
}
export function MobileBotShareCreate(props: {
  review: PhoneShareReview
  toolIds: string[]
  setToolIds: (ids: string[]) => void
  draft: ShareCreateDraft
  setDraft: (update: (draft: ShareCreateDraft) => ShareCreateDraft) => void
  permissionsOpen: boolean
  setPermissionsOpen: (open: boolean) => void
  client: RpcClient | null
  bots: readonly ListedBot[]
  agent: BotAgent
  pickerRows: readonly ReactElement[]
  pickerNote: ReactNode
  ready: boolean
  onBack: () => void
  onMoved: (why: 'updated' | 'stopped' | 'expired') => void
  onCreated: (bot: PhoneBot) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { review } = props
  const { avatar, permission } = props.draft
  const setName = (name: string) => props.setDraft((draft) => ({ ...draft, name }))
  const setAvatar = (next: string) => props.setDraft((draft) => ({ ...draft, avatar: next }))
  const setPermission = (next: SharedBotPermission) =>
    props.setDraft((draft) => ({ ...draft, permission: next }))
  const name =
    props.draft.name ??
    freeBotName(
      review.bot.name,
      props.bots.map((bot) => bot.name)
    )
  const sharedMascot = review.bot.avatar?.mascot
  // The shared picture until the owner shuffles; Create writes a shared image itself.
  const { creating } = props.draft
  const setCreating = (next: boolean) => props.setDraft((draft) => ({ ...draft, creating: next }))
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const canCreate = trimmed.length > 0 && props.ready && props.client !== null && !creating

  const create = async () => {
    if (!canCreate || !props.client) {
      return
    }
    setCreating(true)
    setError(null)
    const picked =
      avatar ??
      (review.avatarDataUrl
        ? null
        : sharedMascot && isBotMascotId(sharedMascot)
          ? mascotAvatar(sharedMascot)
          : null)
    try {
      const { bot } = botCreate.interpret(
        await botCreate.request(props.client, {
          name: trimmed,
          agent: props.agent,
          ...(permission === 'chats' ? {} : { permissionMode: permission }),
          ...(picked ? { avatar: picked } : {}),
          fromShare: { reviewId: review.reviewId, toolIds: props.toolIds }
        })
      )
      props.onCreated(bot)
    } catch (cause) {
      setCreating(false)
      const moved = botShareMoved(cause)
      if (moved) {
        props.onMoved(moved)
        return
      }
      triggerError()
      setError(botShareErrorMessage(cause))
    }
  }

  const options: { id: SharedBotPermission; label: string; description: string }[] = [
    {
      id: 'ask',
      label: t('bots.share.receive.ask', 'Ask for approval'),
      description: t('bots.share.receive.askDetail', 'Picked for bots made from a link')
    },
    {
      id: 'full-access',
      label: t('bots.share.receive.full', 'Full access'),
      description: t('bots.share.receive.fullDetail', 'Runs commands without asking')
    },
    {
      id: 'chats',
      label: t('bots.settings.sameAsChats', 'Same as chats'),
      description: t('bots.share.receive.chatsDetail', 'Starts from your chat permission setting')
    }
  ]
  if (props.permissionsOpen) {
    return (
      <>
        <SheetHeader
          title={t('bots.settings.permissions', 'Permissions')}
          onBack={{
            label: t('bots.new.title', 'New bot'),
            onPress: () => props.setPermissionsOpen(false)
          }}
        />
        <ChoiceRows
          choices={options}
          selected={permission}
          onSelect={(id) => {
            setPermission(id)
            props.setPermissionsOpen(false)
          }}
        />
      </>
    )
  }
  const picture =
    // The shared mascot, picked again by shuffling, keeps its shared look: the host gives it that.
    avatar &&
    !(sharedMascot && isBotMascotId(sharedMascot) && avatar === mascotAvatar(sharedMascot))
      ? mobileBotAvatarSource({ name, avatar })
      : reviewAvatar(review)
  return (
    <>
      <SheetHeader
        title={t('bots.new.title', 'New bot')}
        subtitle={
          review.publisher
            ? t('bots.share.receive.origin', 'From {{who}}’s link', { who: review.publisher })
            : t('bots.share.receive.originAnonymous', 'From a shared link')
        }
        onBack={{ label: t('bots.share.receive.sharedBot', 'Shared bot'), onPress: props.onBack }}
        trailing={{
          label: t('bots.new.create', 'Create'),
          onPress: () => void create(),
          disabled: !canCreate,
          busy: creating
        }}
      />
      <View style={styles.picture}>
        <NewBotPicture avatar={picture} onShuffle={() => setAvatar(randomMascotAvatar(avatar))} />
      </View>
      <ListGroup>
        <TextField
          key="name"
          value={name}
          onChangeText={setName}
          placeholder={t('bots.new.namePlaceholder', 'Name your bot')}
          maxLength={BOT_NAME_MAX_LENGTH}
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void create()}
          style={groupFieldStyles.line}
        />
        {props.pickerRows}
        <DrillRow
          key="permissions"
          label={t('bots.settings.permissions', 'Permissions')}
          value={options.find((option) => option.id === permission)?.label ?? ''}
          onPress={() => props.setPermissionsOpen(true)}
        />
      </ListGroup>
      {props.pickerNote}
      {error ? <SettingsNote error>{error}</SettingsNote> : null}
      {review.bot.tools.length > 0 ? (
        <>
          <SectionHeader title={shareListTitle('tools', t)} />
          <ReviewToolTicks
            review={review}
            toolIds={props.toolIds}
            setToolIds={props.setToolIds}
            first
          />
        </>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  picture: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.lg }
}))
