import { expect, it } from 'vitest'
import { countLookupKeys } from './localization-count-lookups.mjs'

it('finds count-resolved keys without treating explicit suffixes or unrelated options as families', () => {
  expect([
    ...countLookupKeys(
      'fixture.tsx',
      `
    t('items', { count });
    translate('clearMany', 'Clear {{count}}', { count: total });
    i18n.t('nested', { 'count': 5 });
    translateMain('mainItems', { count: 2 });
    t('found_theme_one'); t('found_theme_other');
    t('noPlural', { amount: 2 }); other('unrelated', { count });
    const component = <Trans i18nKey="richItems" count={3} />;
  `
    )
  ]).toEqual(['items', 'clearMany', 'nested', 'mainItems', 'richItems'])
})
