import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { BotTemplateCategory } from '../../../src/shared/bots/bot-templates'

/** A template category's name, as the desktop page says it. */
export function useBotTemplateCategoryLabel(): (category: BotTemplateCategory) => string {
  const t = useMobileTranslation()
  return (category) => {
    switch (category) {
      case 'coding':
        return t('bots.templates.category.coding', 'Coding')
      case 'releases':
        return t('bots.templates.category.releases', 'Releases & CI')
      case 'support':
        return t('bots.templates.category.support', 'Support & triage')
      case 'planning':
        return t('bots.templates.category.planning', 'Planning & docs')
      case 'ops':
        return t('bots.templates.category.ops', 'Ops')
      case 'personal':
        return t('bots.templates.category.personal', 'Personal assistant')
    }
  }
}
