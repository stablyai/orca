import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { colors, onBrightColors } from '../theme/mobile-theme'
import { MobileMarkdown } from './MobileMarkdown'

const openURL = vi.fn((_url: string) => Promise.resolve())

vi.mock('react-native', () => ({
  Linking: { openURL: (url: string) => openURL(url) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  openURL.mockClear()
})

function render(content: string, growing = false): ReactTestRenderer {
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content, growing }))
  })
  return renderer!
}

function flatten(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(flatten).join('')
}

const isText = (node: ReactTestInstance): boolean => String(node.type) === 'Text'

/** Every Text not inside another Text, in reading order: what the reader sees, block by block. */
function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => isText(node) && !(node.parent && hasTextAncestor(node.parent)))
    .map(flatten)
}

function hasTextAncestor(node: ReactTestInstance): boolean {
  return isText(node) || (node.parent !== null && hasTextAncestor(node.parent))
}

function press(tree: ReactTestRenderer, label: string): void {
  const target = tree.root.find(
    (node) => isText(node) && typeof node.props.onPress === 'function' && flatten(node) === label
  )
  act(() => target.props.onPress())
}

describe('MobileMarkdown rendering', () => {
  it.each([
    [
      'C1: nested lists keep their own markers and numbers',
      '1. **Frontend**\n   - React\n   - Vite\n2. Backend',
      ['1.', 'Frontend', '-', 'React', '-', 'Vite', '2.', 'Backend']
    ],
    [
      'C1: blank lines keep one list, and a list cut short keeps its numbers',
      '1. Install\n\n   Pulls in everything.\n\n2. Build\n\nDone.\n\n3. Ship',
      ['1.', 'Install', 'Pulls in everything.', '2.', 'Build', 'Done.', '3.', 'Ship']
    ],
    [
      'C1: a wrapped item stays one item',
      '- a long item\nwrapped at sixty\n- next',
      ['-', 'a long item\nwrapped at sixty', '-', 'next']
    ],
    [
      'C1: a number starting a wrapped line is not a list',
      'We counted to\n42. Then we stop.',
      ['We counted to\n42. Then we stop.']
    ],
    [
      'C2: code, links and emphasis inside bold',
      'Edit **`file.ts`** per **[docs](https://x.com)**, ***both***, *a **b** c*, **bold _ital_**',
      ['Edit file.ts per docs, both, a b c, bold ital']
    ],
    [
      'C4: a fence with an unusual language tag',
      '```c++\nint x;\n```\nAfter.\n\n```ts title="a.ts"\nconst a = 1\n```',
      ['c++', 'int x;', 'After.', 'ts', 'const a = 1']
    ],
    [
      'C5: tilde and four-backtick fences, with HTML inside left alone',
      '~~~html\n<div className="a"><span>Hi</span></div>\n~~~\n\n````md\n```js\nx\n```\n````',
      ['html', '<div className="a"><span>Hi</span></div>', 'md', '```js\nx\n```']
    ],
    [
      'C6: a fence under a list step',
      '1. Install:\n   ```bash\n   pnpm i\n   ```\n2. Run',
      ['1.', 'Install:', 'bash', 'pnpm i', '2.', 'Run']
    ],
    [
      'C7: a table right under a sentence',
      'Here:\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      ['Here:', 'a', 'b', '1', '2']
    ],
    ['C8: short separator rows', '| a | b |\n|:-|-:|\n| 1 | 2 |', ['a', 'b', '1', '2']],
    [
      'C9: a line break inside a table cell',
      '| Flag | Note |\n| --- | --- |\n| -f | Skips checks<br>Use with care |',
      ['Flag', 'Note', '-f', 'Skips checks\nUse with care']
    ],
    ['C14: backslash escapes', '\\*not italic\\* a\\_b a \\| b \\#', ['*not italic* a_b a | b #']],
    ['C15: lone asterisks', '2 * 3 * 4 and *.ts and *.tsx', ['2 * 3 * 4 and *.ts and *.tsx']],
    ['C16: inline code holding a backtick', '``a`b``', ['a`b']],
    [
      'C18: blocks inside a quote',
      '> - a\n>\n> ```sh\n> ls\n> ```\n> > inner',
      ['-', 'a', 'sh', 'ls', 'inner']
    ],
    ['C19: underlined headings and closing hashes', 'Title\n=====\n\n## Sub ##', ['Title', 'Sub']],
    [
      'a README header block reads as its heading',
      '<h1 align="center">Orca</h1>\n\nText',
      ['Orca', 'Text']
    ]
  ])('%s', (_name, content, expected) => {
    expect(texts(render(content))).toEqual(expected)
  })

  it('C12: opens a link with brackets in it, and one with a title, at their own address', () => {
    const tree = render(
      '[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and [docs](https://x.com/a "The docs")'
    )
    press(tree, 'wiki')
    expect(openURL).toHaveBeenLastCalledWith('https://en.wikipedia.org/wiki/Foo_(bar)')
    press(tree, 'docs')
    expect(openURL).toHaveBeenLastCalledWith('https://x.com/a')
  })

  it('C13: opens an angle-bracket link without its brackets', () => {
    const tree = render('Open <http://localhost:3000>.')
    expect(texts(tree)).toEqual(['Open http://localhost:3000.'])
    press(tree, 'http://localhost:3000')
    expect(openURL).toHaveBeenLastCalledWith('http://localhost:3000')
  })

  it('C17: resolves a reference link and draws a footnote', () => {
    const tree = render(
      'See [the docs][1] and a note[^1].\n\n[1]: https://example.com/docs\n\n[^1]: The note.'
    )
    expect(texts(tree)).toEqual(['See the docs and a note[1].', '[1]', 'The note.'])
    press(tree, 'the docs')
    expect(openURL).toHaveBeenLastCalledWith('https://example.com/docs')
  })

  it('C21: closes open markup while a reply grows, and never links a half-written address', () => {
    expect(texts(render('2 * 3 is six.\n\nRead **src/main/ses', true))).toEqual([
      '2 * 3 is six.',
      'Read src/main/ses'
    ])
    const tree = render('See [config loader](https://exa', true)
    expect(texts(tree)).toEqual(['See config loader'])
    expect(tree.root.findAll((node) => typeof node.props.onPress === 'function')).toEqual([])
  })
})

describe('MobileMarkdown tone', () => {
  /** The style a span with exactly `text` draws with, nested arrays flattened in order. */
  function styleOf(root: ReactTestInstance, text: string): Record<string, unknown> {
    const flattenStyle = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? Object.assign({}, ...style.map(flattenStyle))
        : typeof style === 'object' && style !== null
          ? { ...style }
          : {}
    const span = root.find(
      (node) => isText(node) && node.children.length === 1 && node.children[0] === text
    )
    return flattenStyle(span.props.style)
  }

  it("draws your own message dark on its light fill, and leaves the agent's prose as it was", () => {
    const content = 'Plain **bold** [docs](https://example.com) `code`'
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content, tone: 'onBright' }))
    })
    const own = renderer!.root
    expect(styleOf(own, 'bold').color).toBe(colors.bgBase)
    expect(styleOf(own, 'docs').color).toBe(onBrightColors.link)
    expect(styleOf(own, 'code')).toMatchObject({
      color: colors.bgBase,
      backgroundColor: onBrightColors.codeBackground
    })

    act(() => renderer!.update(createElement(MobileMarkdown, { content })))
    expect(styleOf(renderer!.root, 'bold').color).toBe(colors.textPrimary)
    expect(styleOf(renderer!.root, 'docs').color).toBe(colors.accentBlue)
  })

  it('keeps the default palette inside a table, which keeps its dark surface', () => {
    const content = '| **Head** | [docs](https://example.com) |\n| --- | --- |\n| a | b |'
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content, tone: 'onBright' }))
    })
    expect(styleOf(renderer!.root, 'Head').color).toBe(colors.textPrimary)
    expect(styleOf(renderer!.root, 'docs').color).toBe(colors.accentBlue)
  })

  it('zooms every block with the text, not only paragraphs', () => {
    const content = [
      '## Title',
      '> quoted',
      '```ts\nconst a = 1\n```',
      'Use `code` here.',
      '| Cell |\n| --- |\n| x |'
    ].join('\n\n')
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content, textScale: 2 }))
    })
    expect(styleOf(renderer!.root, 'Title').fontSize).toBe(30)
    expect(styleOf(renderer!.root, 'quoted').fontSize).toBe(26)
    expect(styleOf(renderer!.root, 'const a = 1').fontSize).toBe(24)
    expect(styleOf(renderer!.root, 'code').fontSize).toBe(24)
    expect(styleOf(renderer!.root, 'Cell').fontSize).toBe(24)
  })
})

it('renders document images through the image renderer, including reference syntax', () => {
  const renderImage = vi.fn((href: string, alt: string) => createElement('View', { href, alt }))
  act(() => {
    renderer = create(
      createElement(MobileMarkdown, {
        content:
          '![Architecture](assets/diagram.png)\n\n![Reference][diagram]\n\n[diagram]: assets/other.png',
        renderImage
      })
    )
  })
  expect(renderImage).toHaveBeenCalledWith('assets/diagram.png', 'Architecture')
  expect(renderImage).toHaveBeenCalledWith('assets/other.png', 'Reference')
})
