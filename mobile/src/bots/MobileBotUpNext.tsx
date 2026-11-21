import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight } from '../components/icons/app-icons'
import {
  SUGGESTION_LIMITS,
  suggestionLinkLabel,
  type BotUpNext,
  type Suggestion
} from '../../../src/shared/bots/bot-look-around'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import {
  LIST_LEADING_INSET,
  LIST_ROW_PADDING,
  ListGroup,
  ListRow,
  SectionHeader
} from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { openExternalLink } from '../platform/external-links/external-link'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { lookedText } from './bot-up-next-copy'
import { MobileBotTextButton } from './MobileBotTextButton'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'

export type UpNextActions = {
  /** Null while no chat shows to put the request in. */
  start: ((suggestionId: string) => void) | null
  dismiss: (suggestionId: string) => void
  /** Off while one runs or the host is offline. */
  busy: boolean
}

function UpNextRow({ item, actions }: { item: Suggestion; actions: UpNextActions }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { link, source } = item
  const start = actions.start
  return (
    <ListRow
      title={item.title}
      wrapTitle
      subtitle={item.why}
      subtitleLines={0}
      leading={source ? <MobileConnectorSourceIcon source={source} /> : <View />}
      detail={
        <>
          {link ? (
            <Pressable
              style={upNextStyles.link}
              onPress={() => openExternalLink(link)}
              accessibilityRole="link"
            >
              <Text style={upNextStyles.linkText} numberOfLines={1}>
                {suggestionLinkLabel(link)}
              </Text>
              <ArrowUpRight size={12} color={colors.textSecondary} />
            </Pressable>
          ) : null}
          <View style={upNextStyles.actions}>
            {start ? (
              <SheetPrimaryButton
                size="compact"
                label={t('bots.upNext.start', 'Start')}
                disabled={actions.busy}
                onPress={() => start(item.id)}
              />
            ) : null}
            <MobileBotTextButton
              label={t('bots.upNext.dismiss', 'Dismiss')}
              accessibilityLabel={t('bots.upNext.dismissTitle', 'Dismiss {{title}}', {
                title: item.title
              })}
              disabled={actions.busy}
              onPress={() => actions.dismiss(item.id)}
            />
          </View>
        </>
      }
    />
  )
}

/** The desktop's Up next, above the bot's Activity: what its last look suggests. */
export function MobileBotUpNext({
  botName,
  upNext,
  actions
}: {
  botName: string
  upNext: BotUpNext
  actions: UpNextActions
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [expanded, setExpanded] = useState(false)
  const { state, items } = upNext
  const shown = expanded ? items : items.slice(0, SUGGESTION_LIMITS.shown)
  const hiddenCount = items.length - shown.length
  return (
    <View>
      <SectionHeader
        title={t('bots.upNext.title', 'Suggestions')}
        trailing={
          state.running
            ? t('bots.upNext.looking', 'Looking around…')
            : state.lastLookedAt
              ? lookedText(state.lastLookedAt)
              : ''
        }
      />
      {state.error && !state.running ? <Text style={upNextStyles.note}>{state.error}</Text> : null}
      {shown.length > 0 ? (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {[
            ...shown.map((item) => <UpNextRow key={item.id} item={item} actions={actions} />),
            ...(hiddenCount > 0
              ? [
                  <ListRow
                    key="more"
                    title={t('bots.upNext.showMore', 'Show {{count}} more', { count: hiddenCount })}
                    leading={<View />}
                    onPress={() => setExpanded(true)}
                  />
                ]
              : [])
          ]}
        </ListGroup>
      ) : state.running ? null : (
        <Text style={upNextStyles.note}>
          {state.lastLookedAt
            ? t('bots.upNext.empty', 'No suggestions from the last look.')
            : t(
                'bots.upNext.notYet',
                '{{name}} hasn’t looked around yet. Look now in Settings, or it looks on its own a few times a day.',
                { name: botName }
              )}
        </Text>
      )}
    </View>
  )
}

const upNextStyles = themedStyleSheet(() => ({
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
    paddingVertical: spacing.xs
  },
  linkText: {
    fontSize: 11,
    color: colors.textSecondary,
    textDecorationLine: 'underline'
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs
  },
  note: {
    fontSize: 13,
    color: colors.textMuted,
    paddingHorizontal: LIST_ROW_PADDING,
    marginBottom: spacing.md
  }
}))
