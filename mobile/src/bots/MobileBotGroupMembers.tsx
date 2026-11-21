import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useState } from 'react'
import { LayoutAnimation, Pressable, ScrollView, Text, View } from 'react-native'
import { Users } from '../components/icons/app-icons'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { TextField } from '../components/composer-input/TextField'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import type { PhoneBot } from './host-bots-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { groupCreate, groupUpdate } from './bot-group-operations'
import { useBotPurposes } from './use-bot-purposes'
import { groupStyles as styles } from './mobile-bot-group-styles'
import {
  BOT_GROUP_NAME_MAX_LENGTH,
  botGroupMissing,
  botGroupNameSuggestion,
  botGroupPickOrder,
  botGroupUnchanged
} from '../../../src/shared/bots/bot-group-pick'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useReducedMotionEnabled } from '../platform/accessibility/use-reduced-motion'

// The desktop dialog's pop: faces spring in and out as members change.
const POP = LayoutAnimation.create(
  420,
  LayoutAnimation.Types.spring,
  LayoutAnimation.Properties.scaleXY
)

/** New group and Edit group in one sheet: a live picture, the name, then the bots to pick. */
export function MobileBotGroupMembers({
  group,
  bots,
  client,
  onClose,
  onSaved
}: {
  group?: BotGroup
  bots: readonly PhoneBot[]
  client: RpcClient
  onClose: () => void
  onSaved: (group: BotGroup) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const reduced = useReducedMotionEnabled()
  // In pick order: the picture and the suggested name follow it.
  const [selected, setSelected] = useState<string[]>(
    () => group?.members.map((member) => member.botId) ?? []
  )
  const [name, setName] = useState(group?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const purposes = useBotPurposes(client)
  const savedIds = group?.members.map((member) => member.botId) ?? []
  const picked = botGroupPickOrder(savedIds, selected).flatMap(
    (id) => bots.find((bot) => bot.id === id) ?? []
  )
  const suggestion = name
    ? null
    : suggestName(
        picked.map((bot) => bot.name),
        t
      )
  const missingKey = botGroupMissing(picked.length, name, group !== undefined)
  const missing =
    missingKey === 'pickTwo'
      ? t('bots.groups.pickTwo', 'Pick 2 or more bots')
      : missingKey === 'pickOne'
        ? t('bots.groups.pickOne', 'Pick a bot')
        : missingKey === 'nameIt'
          ? t('bots.groups.nameIt', 'Name the group')
          : null
  const unchanged =
    group !== undefined &&
    botGroupUnchanged(
      { name: group.name, botIds: savedIds },
      name,
      picked.map((bot) => bot.id)
    )
  const defaultId = group?.replyMode.kind === 'bot' ? group.replyMode.botId : null
  const toggle = (id: string) => {
    if (reduced === false) {
      LayoutAnimation.configureNext(POP)
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    )
  }
  const save = async () => {
    if (busy || missing || unchanged) {
      return
    }
    setBusy(true)
    const botIds = picked.map((bot) => bot.id)
    try {
      const result = group
        ? groupUpdate.interpret(
            await groupUpdate.request(client, {
              groupId: group.id,
              revision: group.revision,
              name: name.trim(),
              botIds
            })
          )
        : groupCreate.interpret(await groupCreate.request(client, { name: name.trim(), botIds }))
      onSaved(result.group)
    } catch (error) {
      setError(String(error))
      setBusy(false)
    }
  }
  return (
    <BottomDrawer
      visible
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
    >
      <SheetHeader
        titleAboveActions
        title={
          group
            ? t('bots.groups.manageMembers', 'Manage members')
            : t('bots.groups.newGroup', 'New group')
        }
        leading={{
          label: t('bots.groups.cancel', 'Cancel'),
          onPress: onClose,
          disabled: busy
        }}
        trailing={{
          label: group ? t('bots.groups.save', 'Save') : t('bots.groups.create', 'Create'),
          onPress: () => void save(),
          disabled: missing !== null || unchanged,
          busy
        }}
      />
      <View style={styles.picture}>
        {picked.length > 0 ? (
          <MobileBotFaceStack
            slot={96}
            ringColor={colors.sheetSurface}
            faces={picked.map((bot) => ({
              id: bot.id,
              avatar: mobileBotAvatarSource(bot)
            }))}
          />
        ) : (
          // The desktop dialog's empty picture, so the space reads as the group's picture to come.
          <View style={styles.emptyPicture}>
            <Users size={28} strokeWidth={1.5} color={colors.textMuted} />
          </View>
        )}
      </View>
      <View style={styles.inset}>
        <TextField
          value={name}
          onChangeText={setName}
          placeholder={t('bots.groups.namePlaceholder', 'Name your group')}
          maxLength={BOT_GROUP_NAME_MAX_LENGTH}
        />
        {suggestion ? (
          <Pressable accessibilityRole="button" onPress={() => setName(suggestion)}>
            <Text style={[styles.label, styles.centered, styles.suggestion]}>
              {t('bots.groups.useSuggestion', 'Use “{{name}}”', { name: suggestion })}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.members}>
        <ListGroup>
          {bots.map((bot) => (
            <ListRow
              key={bot.id}
              title={bot.name}
              subtitle={purposes.get(bot.id)}
              leading={<MobileBotAvatar avatar={mobileBotAvatarSource(bot)} size={28} />}
              selected={selected.includes(bot.id)}
              accessibilityRole="checkbox"
              disabled={busy}
              onPress={() => toggle(bot.id)}
            />
          ))}
        </ListGroup>
      </ScrollView>
      {missing ? <Text style={styles.notice}>{missing}</Text> : null}
      {defaultId && !selected.includes(defaultId) ? (
        <Text style={styles.notice}>
          {t(
            'bots.groups.removingDefault',
            'Removing {{name}} changes Replies to Only when mentioned.',
            { name: bots.find((bot) => bot.id === defaultId)?.name }
          )}
        </Text>
      ) : null}
      {error ? <Text style={styles.notice}>{error}</Text> : null}
    </BottomDrawer>
  )
}

/** The shared suggestion, in the phone's words. */
function suggestName(
  names: readonly string[],
  t: ReturnType<typeof useMobileTranslation>
): string | null {
  const suggestion = botGroupNameSuggestion(names)
  if (!suggestion) {
    return null
  }
  const text =
    suggestion.key === 'suggestTwo'
      ? t('bots.groups.suggestTwo', '{{a}} & {{b}}', suggestion.values)
      : suggestion.key === 'suggestThree'
        ? t('bots.groups.suggestThree', '{{a}}, {{b}} & {{c}}', suggestion.values)
        : t('bots.groups.suggestMore', '{{a}}, {{b}} & {{count}} more', suggestion.values)
  return text.slice(0, BOT_GROUP_NAME_MAX_LENGTH)
}
