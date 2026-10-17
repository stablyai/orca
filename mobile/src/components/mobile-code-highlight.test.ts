import { expect, it } from 'vitest'
import { highlightMobileCode } from './mobile-code-highlight'
import { mobileCodeTokenStyle } from './mobile-code-highlight-theme'

it('uses registered language grammars while preserving original Unicode, whitespace and line breaks', () => {
  const code = '// comment\nconst message = "世界😀";\n\tconst value = 42;\n'
  const tokens = highlightMobileCode(code, 'ts')
  expect(tokens.map((token) => token.text).join('')).toBe(code)
  expect(tokens.some((token) => token.classes.includes('hljs-keyword'))).toBe(true)
  expect(tokens.some((token) => token.classes.includes('hljs-string'))).toBe(true)
  expect(tokens.some((token) => token.classes.includes('hljs-number'))).toBe(true)
})
it('keeps unknown languages, unlabeled and very large code readable without autodetection', () => {
  const code = '<script>世界😀</script>\n'
  for (const language of [undefined, 'unknown-language']) {
    expect(highlightMobileCode(code, language)).toEqual([{ text: code, classes: [] }])
  }
  const large = 'const value = 42;\n'.repeat(3_000)
  expect(highlightMobileCode(large, 'js')).toEqual([{ text: large, classes: [] }])
})
it('matches desktop Markdown colors and resolves nested tokens in both themes', () => {
  expect(mobileCodeTokenStyle(['hljs-keyword'], 'light').color).toBe('#cf222e')
  expect(mobileCodeTokenStyle(['hljs-keyword'], 'dark').color).toBe('#ff7b72')
  expect(mobileCodeTokenStyle(['hljs-string', 'hljs-subst'], 'light').color).toBe('#24292f')
  expect(mobileCodeTokenStyle(['hljs-comment'], 'dark').fontStyle).toBe('italic')
})

it('keeps recent highlights reusable while evicting beyond the character budget', () => {
  const code = (index: number) => `// ${'x'.repeat(35_000)} ${index}`
  const first = highlightMobileCode(code(0), 'js')
  expect(highlightMobileCode(code(0), 'js')).toBe(first)
  let latest = first
  for (let index = 1; index < 8; index++) {
    latest = highlightMobileCode(code(index), 'js')
  }
  expect(highlightMobileCode(code(7), 'js')).toBe(latest)
  expect(highlightMobileCode(code(0), 'js')).not.toBe(first)
})
