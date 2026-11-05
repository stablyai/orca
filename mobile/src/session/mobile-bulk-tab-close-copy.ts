import type { Translate } from '../i18n/mobile-i18n'

export function mobileBulkTabCloseCopy(t: Translate) {
  return {
    title: {
      others: t('session.bulkTabClose.titleOthers', 'Close other tabs?'),
      right: t('session.bulkTabClose.titleRight', 'Close tabs to the right?'),
      left: t('session.bulkTabClose.titleLeft', 'Close tabs to the left?'),
      editors: t('session.bulkTabClose.titleEditors', 'Close all editor tabs?')
    },
    description: t(
      'session.bulkTabClose.description',
      'The selected tabs will be closed. Pinned tabs will stay open.'
    ),
    confirm: t('session.bulkTabClose.confirm', 'Close tabs')
  }
}
