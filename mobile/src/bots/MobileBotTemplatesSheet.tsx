// The phone's bot templates, from New bot's "Start from a template": search, category pills, then the
// desktop page's rows; a tap opens the template's detail, whose Use template… prefills New bot.
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { MobileNoMatchState } from '../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { FilterChip } from '../components/nav-bar/FilterChip'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { templateProposal, type BotProposal } from '../../../src/shared/bots/bot-proposal'
import {
  BOT_TEMPLATE_CATEGORIES,
  type BotTemplate,
  type BotTemplateCategory
} from '../../../src/shared/bots/bot-templates'
import {
  botTemplateGroups,
  botTemplateMatches,
  freeBotName
} from '../../../src/shared/bots/bot-template-view'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotTemplateDetail } from './MobileBotTemplateDetail'
import { useBotTemplateCategoryLabel } from './mobile-bot-template-labels'

export type BotTemplatePick = { proposal: BotProposal; origin: string } | { blank: true }

export function MobileBotTemplatesSheet(props: {
  visible: boolean
  /** Names of the bots there now, so a template's name is free ("Pull request review 2"). */
  botNames: readonly string[]
  onClose: () => void
  onPick: (pick: BotTemplatePick) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const label = useBotTemplateCategoryLabel()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<BotTemplateCategory | null>(null)
  const [detail, setDetail] = useState<BotTemplate | null>(null)
  const groups = botTemplateGroups(
    (template) =>
      (category === null || template.category === category) &&
      botTemplateMatches(template, query, label)
  )
  const pick = (template: BotTemplate) => {
    setDetail(null)
    props.onPick({
      proposal: templateProposal(template, { name: freeBotName(template.name, props.botNames) }),
      origin: t('bots.templates.originTemplateNamed', 'From the {{template}} template', {
        template: template.name
      })
    })
  }
  const pill = (value: BotTemplateCategory | null, text: string) => (
    <FilterChip
      key={value ?? 'all'}
      label={text}
      active={category === value}
      onPress={() => setCategory(value)}
    />
  )

  return (
    <>
      <BottomDrawer
        visible={props.visible && detail === null}
        onClose={props.onClose}
        contentScrollable
      >
        <SheetHeader title={t('bots.templates.title', 'Bot templates')} onClose={props.onClose} />
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('bots.templates.search', 'Search templates')}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.pills}
          contentContainerStyle={styles.pillRow}
        >
          {pill(null, t('bots.templates.allCategories', 'All'))}
          {BOT_TEMPLATE_CATEGORIES.map((entry) => pill(entry, label(entry)))}
        </ScrollView>
        {groups.length === 0 ? (
          <MobileNoMatchState
            message={t('bots.templates.noMatch', 'No templates match “{{query}}”', {
              query: query.trim()
            })}
            onClear={() => setQuery('')}
          />
        ) : null}
        {groups.map((group, index) => (
          <View key={group.category}>
            <SectionHeader first={index === 0} title={label(group.category)} />
            <ListGroup>
              {group.templates.map((template) => (
                <ListRow
                  key={template.id}
                  leading={
                    <MobileBotAvatar avatar={{ kind: 'mascot', id: template.mascot }} size={32} />
                  }
                  title={template.name}
                  subtitle={template.line}
                  navigates
                  onPress={() => setDetail(template)}
                />
              ))}
            </ListGroup>
          </View>
        ))}
        <ListGroup>
          <ListRow
            title={t('bots.templates.blank', 'Blank bot')}
            subtitle={t('bots.templates.blankLine', 'Tell it what it’s for in its first chat.')}
            leading={<Plus size={18} color={colors.textMuted} />}
            onPress={() => props.onPick({ blank: true })}
          />
        </ListGroup>
      </BottomDrawer>
      {detail ? (
        <MobileBotTemplateDetail
          template={detail}
          visible={props.visible}
          onClose={() => setDetail(null)}
          onUse={() => pick(detail)}
        />
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  pills: { flexGrow: 0, marginTop: spacing.xs },
  pillRow: { gap: spacing.sm }
}))
