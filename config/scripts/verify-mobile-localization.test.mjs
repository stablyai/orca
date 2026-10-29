import { describe, expect, it } from 'vitest'

import {
  collectExtractionProblems,
  collectIncompletePluralFamilies,
  collectLiveSwitchViolations
} from './verify-mobile-localization.mjs'

describe('verify-mobile-localization', () => {
  it('rejects translations that cannot follow a live language switch', () => {
    const source = [
      "const LABELS = [translate('a.b', 'Module scope')]",
      'export function Row({ items }) {',
      "  const onPress = () => Alert.alert(translate('a.d', 'Handler runs at press time'))",
      "  useEffect(() => setTitle(translate('a.h', 'Effect')), [])",
      "  const label = useMemo(() => translate('a.g', 'Memo'), [])",
      "  return items.map((item) => <Text key={item}>{translate('a.c', 'Render callback')}</Text>)",
      '}',
      'export function Subscribed() {',
      '  const t = useMobileTranslation()',
      "  return <Pressable onPress={() => translate('a.i', 'Pressed')}>{t('a.e', 'Hook')}</Pressable>",
      '}',
      "export function rowLabel() { return translate('a.f', 'Helper') }",
      "export default function () { return <Text>{translate('a.j', 'Screen')}</Text> }"
    ].join('\n')

    expect(collectLiveSwitchViolations('mobile/src/row.tsx', source)).toEqual([
      'mobile/src/row.tsx:1 translates at module scope; translate when rendering instead',
      'mobile/src/row.tsx:5 calls translate() in a component or hook; use `const t = useMobileTranslation()`',
      'mobile/src/row.tsx:6 calls translate() in a component or hook; use `const t = useMobileTranslation()`',
      'mobile/src/row.tsx:13 calls translate() in a component or hook; use `const t = useMobileTranslation()`'
    ])
  })

  it('requires every CLDR category once a locale translates a plural family', () => {
    const english = new Map([
      ['files_one', '{{count}} file'],
      ['files_other', '{{count}} files']
    ])

    expect(
      collectIncompletePluralFamilies(
        english,
        new Map([
          ['files_one', '{{count}} файл'],
          ['files_other', '{{count}} файла']
        ]),
        'ru'
      )
    ).toEqual(['files: missing _few, _many'])
    expect(
      collectIncompletePluralFamilies(english, new Map([['files_other', '{{count}} 件']]), 'ja')
    ).toEqual([])
  })

  it('keeps a plural family while any of its forms is referenced', () => {
    const english = {
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      gone_one: '{{count}} gone',
      gone_other: '{{count}} gone'
    }
    const references = [{ key: 'items_one', fallback: '{{count}} item' }]
    const evidence = { literals: new Set(), dynamicPrefixes: new Set() }

    expect(collectExtractionProblems(references, english, evidence).unreferenced).toEqual([
      'gone_one',
      'gone_other'
    ])
  })
})
