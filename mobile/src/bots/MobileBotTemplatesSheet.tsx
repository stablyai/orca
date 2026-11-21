// The phone's bot templates, from New bot's "Use template": search, category pills, then the
// desktop page's rows; a tap opens the template's detail, whose Use template… prefills New bot.
import { useState } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'
import { Plus } from '../components/icons/app-icons'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { MobileNoMatchState } from '../components/feedback/MobileStateView'
import { LIST_ROW_PADDING, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { FilterChip } from '../components/nav-bar/FilterChip'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { templateProposal, type BotProposal } from '../../../src/shared/bots/bot-proposal'
import {
  BOT_TEMPLATE_CATEGORIES,
  botTemplate,
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

const AVATAR_SIZE = 32

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
  const pager = useOptionPager<string>()
  const detail = botTemplate(pager.page ?? undefined)
  // Back returns to the list: inside New bot's modal host Back reaches the host's claims, elsewhere BackHandler.
  useBottomDrawerModalHostBackClaim(detail ? pager.close : null)
  useBackClaim(
    detail
      ? () => {
          pager.close()
          return true
        }
      : null
  )
  const groups = botTemplateGroups(
    (template) =>
      (category === null || template.category === category) &&
      botTemplateMatches(template, query, label)
  )
  const pick = (template: BotTemplate) => {
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

  const main = (
    <View style={styles.page}>
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
      <ScrollView
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
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
            <ListGroup separatorInset={LIST_ROW_PADDING + AVATAR_SIZE + spacing.md}>
              {group.templates.map((template) => (
                <ListRow
                  key={template.id}
                  leading={
                    <MobileBotAvatar
                      avatar={{ kind: 'mascot', id: template.mascot }}
                      size={AVATAR_SIZE}
                    />
                  }
                  title={template.name}
                  subtitle={template.line}
                  navigates
                  onPress={() => {
                    // The search field stays mounted under the page, so its keyboard would cover the detail.
                    Keyboard.dismiss()
                    pager.open(template.id)
                  }}
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
      </ScrollView>
    </View>
  )

  // A fixed height, as the sibling filterable sheets have, so filtering never resizes the sheet.
  return (
    <BottomDrawer
      visible={props.visible}
      onClose={props.onClose}
      onAfterClose={pager.forget}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      <OptionPager
        pager={pager}
        main={main}
        page={
          detail ? (
            <MobileBotTemplateDetail
              template={detail}
              onBack={pager.close}
              onUse={() => pick(detail)}
            />
          ) : null
        }
        fill
      />
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1 },
  pills: { flexGrow: 0, marginTop: spacing.xs },
  pillRow: { gap: spacing.sm }
}))
