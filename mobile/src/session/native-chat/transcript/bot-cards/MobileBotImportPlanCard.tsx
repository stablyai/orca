// The plan a bot shows with `orca bot import plan`, as the desktop's card: what comes over, what changes and
// what stays behind, a tick on each thing that can come. Import tells the bot the desktop's same sentence.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, Download } from '../../../../components/icons/app-icons'
import {
  BOT_IMPORT_PLAN_GROUPS,
  botImportAnswer,
  type BotImportPlan,
  type BotImportPlanGroup
} from '../../../../../../src/shared/bots/bot-import-cards'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions, MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'
import { useMobileBotOfferAnswer } from './use-mobile-bot-offer-answer'

function groupTitle(t: Translate, group: BotImportPlanGroup, app: string): string {
  switch (group) {
    case 'comes':
      return t('chat.botCards.importPlan.comes', 'Comes over')
    case 'changed':
      return t('chat.botCards.importPlan.changed', 'Comes over with changes')
    case 'already':
      return t('chat.botCards.importPlan.already', 'Already here')
    case 'stays':
      return t('chat.botCards.importPlan.stays', 'Stays in {{app}}', { app })
  }
}

const ticks = (group: BotImportPlanGroup): boolean => group === 'comes' || group === 'changed'

export function MobileBotImportPlanCard({
  plan,
  cardId,
  fontScale
}: {
  plan: BotImportPlan
  cardId: string
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const answer = useMobileBotOfferAnswer(plan.botId, cardId)
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set())
  const items = plan.items.map((item, index) => ({ ...item, index }))
  const bringable = items.filter((item) => ticks(item.group))
  const { sent } = answer
  // Once sent, the ticks are the answer kept on the bot, so every device shows what was asked.
  const leftOut = sent
    ? new Set(
        bringable.filter((item) => !sent.includes(String(item.index))).map((item) => item.index)
      )
    : unticked
  const chosen = bringable.filter((item) => !leftOut.has(item.index))
  const toggle = (index: number) => {
    const next = new Set(leftOut)
    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }
    setUnticked(next)
  }
  const meta = scaledType(typography.metaSize, fontScale, 4)
  const body = scaledType(typography.bodySize, fontScale, 4)
  return (
    <MobileBotCardFrame
      avatar={<Download size={14} color={colors.textMuted} />}
      heading={
        plan.again
          ? t('chat.botCards.importPlan.fromAgain', 'From {{app}}, again', { app: plan.app })
          : t('chat.botCards.importPlan.from', 'From {{app}}', { app: plan.app })
      }
      title={plan.name}
      fontScale={fontScale}
      testID={`bot-import-plan-card:${cardId}`}
    >
      {BOT_IMPORT_PLAN_GROUPS.map((group) => {
        const entries = items.filter((item) => item.group === group)
        if (entries.length === 0) {
          return null
        }
        return (
          <View key={group} style={styles.group}>
            <Text style={[styles.groupTitle, meta]}>{groupTitle(t, group, plan.app)}</Text>
            {entries.map((item) => {
              const on = ticks(group) && !leftOut.has(item.index)
              const text = (
                <View style={styles.itemText}>
                  <Text style={[on ? styles.what : styles.whatOff, body]}>
                    {item.what}
                    {item.to ? <Text style={styles.to}>{` → ${item.to}`}</Text> : null}
                  </Text>
                  <Text style={[styles.why, meta]}>{item.why}</Text>
                </View>
              )
              return ticks(group) ? (
                <Pressable
                  key={item.index}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: sent !== null }}
                  disabled={sent !== null}
                  hitSlop={4}
                  onPress={() => toggle(item.index)}
                  style={({ pressed }) => [styles.item, pressed && pressedStyle]}
                >
                  <View style={[styles.box, on && styles.boxOn]}>
                    {on ? <Check size={11} color={colors.bgBase} strokeWidth={3} /> : null}
                  </View>
                  {text}
                </Pressable>
              ) : (
                <View key={item.index} style={styles.item}>
                  <Text style={[styles.dash, body]}>–</Text>
                  {text}
                </View>
              )
            })}
          </View>
        )
      })}
      {sent === null ? (
        <>
          <MobileBotCardMeta fontScale={fontScale} lines={2}>
            {t(
              'chat.botCards.importPlan.selected',
              '{{chosen}} of {{total}} selected · keys and logins are never copied',
              { chosen: chosen.length, total: bringable.length }
            )}
          </MobileBotCardMeta>
          {answer.error ? <Text style={[styles.error, meta]}>{answer.error}</Text> : null}
          <MobileBotCardActions>
            {answer.dismissed ? null : (
              <MobileNativeChatNoticePill
                label={t('chat.botCards.offer.notNow', 'Not now')}
                disabled={!answer.ready}
                onPress={answer.dismiss}
              />
            )}
            <MobileNativeChatNoticePill
              label={
                chosen.length === 1
                  ? t('chat.botCards.importPlan.importOne', 'Import 1 item')
                  : t('chat.botCards.importPlan.importMany', 'Import {{count}} items', {
                      count: chosen.length
                    })
              }
              primary
              disabled={chosen.length === 0 || !answer.ready}
              onPress={() =>
                answer.send(
                  botImportAnswer(plan, leftOut),
                  chosen.map((item) => String(item.index))
                )
              }
            />
          </MobileBotCardActions>
        </>
      ) : (
        <View style={styles.asked}>
          <Check size={12} color={colors.textMuted} />
          <MobileBotCardMeta fontScale={fontScale}>
            {chosen.length === 1
              ? t('chat.botCards.importPlan.askedOne', 'Asked to import 1 item')
              : t('chat.botCards.importPlan.askedMany', 'Asked to import {{count}} items', {
                  count: chosen.length
                })}
          </MobileBotCardMeta>
        </View>
      )}
    </MobileBotCardFrame>
  )
}

const BOX = 16

const styles = themedStyleSheet(() => ({
  group: { gap: spacing.xs },
  groupTitle: { color: colors.textSecondary, fontWeight: '600' },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 3 },
  box: {
    width: BOX,
    height: BOX,
    marginTop: 2,
    borderRadius: radii.mark,
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  boxOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  dash: { width: BOX, textAlign: 'center', color: colors.textMuted },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  what: { color: colors.textPrimary },
  whatOff: { color: colors.textMuted },
  to: { color: colors.textMuted },
  why: { color: colors.textMuted },
  asked: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  error: { color: colors.statusRed }
}))
