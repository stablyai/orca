import type { MobileColorScheme } from '../theme/mobile-theme'

// Desktop markdown-preview.css's GitHub-inspired hljs palette, adapted to native Text spans.
const light = {
  text: '#24292f',
  comment: '#6e7781',
  keyword: '#cf222e',
  string: '#0a3069',
  number: '#0550ae',
  title: '#8250df',
  type: '#0550ae',
  attr: '#0550ae',
  variable: '#953800',
  tag: '#116329',
  symbol: '#0550ae',
  meta: '#1f7f34',
  addition: '#116329',
  deletion: '#82071e'
}
const dark: typeof light = {
  text: '#e6edf3',
  comment: '#8b949e',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  title: '#d2a8ff',
  type: '#ffa657',
  attr: '#79c0ff',
  variable: '#ffa657',
  tag: '#7ee787',
  symbol: '#d2a8ff',
  meta: '#79c0ff',
  addition: '#aff5b4',
  deletion: '#ffdcd7'
}
const aliases: Record<string, keyof typeof light> = {
  quote: 'comment',
  'selector-tag': 'keyword',
  'template-tag': 'keyword',
  doctag: 'string',
  regexp: 'string',
  literal: 'number',
  section: 'title',
  built_in: 'type',
  attribute: 'attr',
  'template-variable': 'variable',
  name: 'tag',
  bullet: 'symbol',
  'selector-class': 'symbol',
  'selector-id': 'symbol',
  subst: 'text'
}
export function mobileCodeTokenStyle(classes: readonly string[], scheme: MobileColorScheme) {
  const palette: Record<string, string> = scheme === 'dark' ? dark : light
  let color = palette.text
  for (const name of classes) {
    const token = name.replace(/^hljs-/, '')
    const key = aliases[token] ?? token
    if (Object.hasOwn(palette, key)) {
      color = palette[key]
    }
  }
  return {
    color,
    ...(classes.includes('hljs-addition')
      ? {
          backgroundColor: scheme === 'dark' ? 'rgba(46, 160, 67, 0.15)' : 'rgba(46, 160, 67, 0.1)'
        }
      : {}),
    ...(classes.includes('hljs-deletion')
      ? {
          backgroundColor: scheme === 'dark' ? 'rgba(248, 81, 73, 0.15)' : 'rgba(248, 81, 73, 0.1)'
        }
      : {}),
    ...(classes.some((name) => ['hljs-comment', 'hljs-quote', 'hljs-emphasis'].includes(name))
      ? { fontStyle: 'italic' as const }
      : {}),
    ...(classes.includes('hljs-strong') ? { fontWeight: '700' as const } : {})
  }
}
