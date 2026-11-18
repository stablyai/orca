// The phone's bot templates, from New bot's "Start from a template": search, category pills, then the
// desktop page's rows; a tap opens the template's detail, whose Use template… prefills New bot.
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Plus, Search } from 'lucide-react-native'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { TextField } from '../components/composer-input/TextField'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
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
    <Pressable
      key={value ?? 'all'}
      onPress={() => setCategory(value)}
      style={[styles.pill, category === value && styles.pillOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: category === value }}
    >
      <Text style={[styles.pillText, category === value && styles.pillTextOn]}>{text}</Text>
    </Pressable>
  )

  return (
    <>
      <BottomDrawer
        visible={props.visible && detail === null}
        onClose={props.onClose}
        contentScrollable
      >
        <Text style={styles.title}>{t('bots.templates.title', 'Bot templates')}</Text>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder={t('bots.templates.search', 'Search templates')}
          accessibilityLabel={t('bots.templates.search', 'Search templates')}
          leading={<Search size={16} color={colors.textMuted} />}
          autoCorrect={false}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pills}>
          {pill(null, t('bots.templates.allCategories', 'All'))}
          {BOT_TEMPLATE_CATEGORIES.map((entry) => pill(entry, label(entry)))}
        </ScrollView>
        {groups.length === 0 ? (
          <Text style={styles.empty}>
            {t('bots.templates.noMatch', 'No templates match “{{query}}”', { query: query.trim() })}
          </Text>
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
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  pills: { flexGrow: 0, marginTop: spacing.sm },
  pill: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.xs
  },
  pillOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  pillText: { fontSize: 13, color: colors.textSecondary },
  pillTextOn: { color: colors.bgBase },
  empty: { fontSize: 13, color: colors.textMuted, padding: spacing.md, textAlign: 'center' }
}))
