// Add a connector, as a page inside Connectors: the desktop's AddConnectorDialog, built like Bot templates
// (search, category chips, one grouped list). Lists what the phone can add, and Manage for what the bot has.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { Webhook } from 'lucide-react-native'
import { MobileSearchField } from '../../components/controls/MobileSearchField'
import { MobileNoMatchState } from '../../components/feedback/MobileStateView'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { FilterChip } from '../../components/nav-bar/FilterChip'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorSourceIcon, MobileGoogleMark } from '../MobileConnectorSourceIcon'

type Category = 'coding' | 'chat' | 'docs' | 'mail'

/** One row; `added` rows open the bot's own page for it, the rest add it. */
export type AddConnectorOption = {
  id: 'slack' | 'github' | 'linear' | 'google' | 'webhooks'
  added: boolean
  /** Added and can take another workspace or org here. */
  addAnother?: () => void
  /** Not added: how the phone adds it; none hides the row. */
  add?: () => void
  manage: () => void
}

const CATEGORY: Record<AddConnectorOption['id'], Category | null> = {
  github: 'coding',
  slack: 'chat',
  linear: 'docs',
  google: 'mail',
  webhooks: null
}

export function MobileBotAddConnector(props: {
  botName: string
  options: readonly AddConnectorOption[]
  disabled: boolean
  banner: ReactNode
  onBack: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Category | 'mine' | null>(null)
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const copy: Record<AddConnectorOption['id'], { name: string; line: string; icon: ReactNode }> = {
    slack: {
      name: BOT_CONNECTOR_NAMES.slack,
      line: t('bots.apps.line.slack', 'Messages and mentions'),
      icon: <MobileConnectorSourceIcon source="slack" size={20} />
    },
    github: {
      name: BOT_CONNECTOR_NAMES.github,
      line: t('bots.apps.line.github', 'Mentions and events on issues and PRs'),
      icon: <MobileConnectorSourceIcon source="github" size={20} />
    },
    linear: {
      name: BOT_CONNECTOR_NAMES.linear,
      line: t('bots.apps.line.linear', 'Assigned issues and mentions'),
      icon: <MobileConnectorSourceIcon source="linear" size={20} />
    },
    google: {
      name: BOT_CONNECTOR_NAMES.google,
      line: t('bots.apps.line.google', 'Gmail, Calendar and Drive, as you'),
      icon: <MobileGoogleMark size={20} />
    },
    webhooks: {
      name: t('bots.webhooks.name', 'Webhooks'),
      line: t('bots.apps.webhooks.line', 'Events from any tool or script'),
      icon: <Webhook size={20} color={colors.textSecondary} />
    }
  }
  const categoryLabel: Record<Category, string> = {
    coding: t('bots.apps.category.coding', 'Coding'),
    chat: t('bots.apps.category.chat', 'Chat'),
    docs: t('bots.apps.category.docs', 'Docs and projects'),
    mail: t('bots.apps.category.mail', 'Mail and meetings')
  }
  const listed = props.options.filter((option) => option.added || option.add)
  const mine = listed.filter((option) => option.added)
  const needle = query.trim().toLocaleLowerCase()
  const shown = listed.filter(
    (option) =>
      (filter === null || (filter === 'mine' ? option.added : CATEGORY[option.id] === filter)) &&
      (needle === '' ||
        `${copy[option.id].name} ${copy[option.id].line}`.toLocaleLowerCase().includes(needle))
  )
  const categories = (['coding', 'chat', 'docs', 'mail'] as const).filter((category) =>
    listed.some((option) => CATEGORY[option.id] === category)
  )
  const chip = (value: Category | 'mine' | null, label: string) => (
    <FilterChip
      key={value ?? 'all'}
      label={label}
      active={filter === value}
      onPress={() => setFilter(value)}
    />
  )
  return (
    <>
      <SheetHeader
        title={t('settings.bots.addConnector', 'Add a connector')}
        subtitle={props.botName}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
      />
      {props.banner}
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('bots.apps.search', 'Search apps')}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.chips}
        contentContainerStyle={styles.chipRow}
      >
        {chip(null, t('bots.apps.allShort', 'All'))}
        {mine.length > 0
          ? chip(
              'mine',
              `${t('bots.apps.onBot', 'On {{bot}}', { bot: props.botName })} ${mine.length}`
            )
          : null}
        {categories.map((category) => chip(category, categoryLabel[category]))}
      </ScrollView>
      {shown.length === 0 ? (
        <MobileNoMatchState
          message={t('bots.apps.noMatch', 'No app matches “{{query}}”.', { query: query.trim() })}
          onClear={() => setQuery('')}
        />
      ) : (
        <View>
          <SectionHeader title={t('bots.apps.connectors', 'Connectors')} />
          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {shown.map((option) => {
              const { name, line, icon } = copy[option.id]
              const action = option.added
                ? option.addAnother
                  ? {
                      label:
                        option.id === 'github'
                          ? t('bots.connectors.addOrg', 'Add org')
                          : t('bots.connectors.addWorkspace', 'Add workspace'),
                      onPress: option.addAnother
                    }
                  : {
                      label: t('bots.connectors.manage', 'Manage'),
                      onPress: option.manage
                    }
                : { label: t('bots.apps.add', 'Add'), onPress: option.add! }
              return (
                <ListRow
                  key={option.id}
                  leading={icon}
                  title={name}
                  subtitle={line}
                  onPress={option.added ? option.manage : option.add}
                  disabled={props.disabled && !option.added}
                  accessory={
                    <MobileBotTextButton
                      label={action.label}
                      disabled={props.disabled}
                      onPress={action.onPress}
                    />
                  }
                />
              )
            })}
          </ListGroup>
        </View>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  chips: { flexGrow: 0, marginTop: spacing.xs },
  chipRow: { gap: spacing.sm }
}))
