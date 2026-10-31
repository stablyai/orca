import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const CODE = '```md\n# not a heading\n- not an item\n```'
const TEXT = [
  'Intro paragraph.',
  '',
  '# Title',
  '## Section `one`',
  '- first **item**',
  '  wrapped line',
  '  - nested',
  '1. step',
  '',
  '---',
  CODE
].join('\n')

/**
 * Stands for the engine beneath the mod: records the text it is asked to draw
 * and answers for the settings.
 */
const engine = (on: On, settings: Record<string, unknown> = {}) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    drawn.push(e.props.text)

    return { type: 'engine', ref: 0 }
  })
  on('settings.read', () => ({ value: settings }))

  return drawn
}

const mount = ($: Engine, text: string) =>
  $.ui.mount({
    plugin: 'reply-markdown',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true }
  })

test('heading closing markers preserve hashes that belong to the title', async ($, on) => {
  engine(on)
  for (const [source, title] of [
    ['## Learning C#', 'Learning C#'],
    ['## Learning F#   ', 'Learning F#'],
    ['## Learning C# ###', 'Learning C#'],
    ['## Topic ###', 'Topic']
  ]) {
    const ui = await mount($, source!)
    expect(await ui.find({ type: 'Text', text: `▌ ${title}` })).toBeDefined()
    await ui.unmount()
  }
})

test('prose deletion is styled while inline and fenced code remain literal', async ($, on) => {
  engine(on)
  const literal = '**This is not bold inside this block**\n`sss`\n~~literal~~\n$' + 'x^2$'
  const ui = await mount(
    $,
    `**Bold**, *italic*, and ~~strikethrough text~~. Inline: \`~~literal~~\` and \`sss\`.\n\n\`\`\`text\n${literal}\n\`\`\``
  )
  expect(
    (await ui.findAll({ type: 'Text', text: /^strikethrough text$/ })).some(
      (x) => x.props.strikethrough === true
    )
  ).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^Bold$/ }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^italic$/ }))?.props.italic).toBe(true)
  expect(
    (await ui.find({ type: 'Text', text: /^~~literal~~$/ }))?.props.strikethrough
  ).toBeUndefined()
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(literal)
})

test('escaped tildes and unmatched deletion markers stay on the normal path', async ($, on) => {
  const drawn = engine(on)
  const text = 'Keep \\~\\~literal\\~\\~ and `~~code~~` and ~~unclosed.'
  const ui = await mount($, text)
  expect(drawn).toEqual([text])
  expect(await ui.find({ type: 'Text', text: 'literal' })).toBeUndefined()
})

test('deletion works in lists, quotes and table cells', async ($, on) => {
  engine(on)
  const ui = await mount(
    $,
    '- ~~old item~~\n\n> ~~old quote~~\n\n| A | B |\n|---|---|\n| ~~old cell~~ | new |'
  )
  for (const text of ['old item', 'old quote', 'old cell']) {
    expect(
      (await ui.findAll({ type: 'Text', text })).some(
        (x) => x.text === text && x.props.strikethrough === true
      )
    ).toBe(true)
  }
})

test('deletion keeps nested emphasis and link targets', async ($, on) => {
  engine(on)
  const ui = await mount($, '~~old **bold** text~~ and [example](https://example.com/a_thing).')
  expect((await ui.find({ type: 'Text', text: /^bold$/ }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://example.com/a_thing')
})

for (const delimiter of ['*', '_']) {
  test(`deletion prose preserves bold nested inside ${delimiter} italic`, async ($, on) => {
    engine(on)
    const ui = await mount(
      $,
      `~~x~~ ${delimiter}a ${delimiter.repeat(2)}b${delimiter.repeat(2)} c${delimiter}`
    )
    try {
      expect((await ui.find({ type: 'Text', text: /^a b c$/ }))?.props.italic).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^b$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^x$/ }))?.props.strikethrough).toBe(true)
    } finally {
      await ui.unmount()
    }
  })
}

test("headings, list items and rules are the mod's, the rest the engine's", async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, TEXT)
  const shown = async (text: string) => (await ui.find({ type: 'Text', text }))?.props
  const items = await ui.findAll({ type: 'Markdown' })

  expect(drawn).toEqual(['Intro paragraph.'])
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({
    source: '# not a heading\n- not an item',
    language: 'md'
  })
  expect(await shown(' Title ')).toMatchObject({ backgroundColor: '#6b50ff', bold: true })
  expect(await shown('▌ Section one')).toMatchObject({ color: '#ff60ff', bold: true })
  expect(await shown('• ')).toMatchObject({ color: '#00ffb2' })
  expect(await shown('◦ ')).toMatchObject({ color: '#00ffb2' })
  expect(await shown('1. ')).toMatchObject({ color: '#e8fe96' })
  expect(await shown('⏺ ')).toBeDefined()
  expect(items.map((item) => item.props.text)).toEqual([
    'first **item**\nwrapped line',
    'nested',
    'step'
  ])
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  await ui.unmount()
})

test('a longer fence is not closed by a shorter one inside it', async ($, on) => {
  const nested = '````md\n```js\ncode\n```\n# still code\n````'
  const drawn = engine(on)
  const ui = await mount($, `## Real heading\n${nested}`)

  expect(drawn).toEqual([])
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('```js\ncode\n```\n# still code')
  expect(await ui.findAll({ type: 'Text', text: /heading/ })).toHaveLength(1)
  await ui.unmount()
})

test('quote lines are one dim block beside a bar', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, '> first **line**\n> second\n\nAfter.\n\n```\n> code\n```')

  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({
    text: 'first **line**\nsecond',
    dimColor: true
  })
  expect((await ui.find({ type: 'Text', text: /^│/ }))?.props).toMatchObject({ color: '#ff60ff' })
  expect(drawn).toEqual(['After.'])
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('> code')
  await ui.unmount()
})

test("the mod's blocks keep to the maxProseWidth setting", async ($, on) => {
  engine(on, { maxProseWidth: 40 })
  const ui = await mount($, '- item\n\n---')

  expect(await ui.find({ type: 'Text', text: /^─{40}$/ })).toBeDefined()
  await ui.unmount()
})

test('a reply with nothing to restyle is left to the engine whole', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, 'Just a paragraph.\n\nAnd another, with `code` in it.')

  expect(drawn).toEqual(['Just a paragraph.\n\nAnd another, with `code` in it.'])
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('bold that Chinese punctuation ends is closable, code left as written', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount(
    $,
    [
      '**短答：就夠了。**記憶函式庫',
      '',
      '看**「重點」**吧，**用 `grep`。**後，`**a。**b`',
      '',
      '**Note:** text, **檔案**：Claude, **x。**',
      '',
      '- **Letta 的實驗。**Letta 是',
      '',
      '```md\n**x。**y\n```'
    ].join('\n')
  )

  expect(drawn).toEqual([
    '**短答：就夠了**。記憶函式庫\n\n看「**重點**」吧，**用 `grep`**。後，`**a。**b`\n\n**Note:** text, **檔案**：Claude, **x。**'
  ])
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('**Letta 的實驗**。Letta 是')
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('**x。**y')
  await ui.unmount()
})

test('a reply of raw text alone reaches the engine with its bold closable', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, '**收斂。**記憶')

  expect(drawn).toEqual(['**收斂**。記憶'])
  await ui.unmount()
})

test('tells Claude its forms only where a terminal draws the reply', async ($, on) => {
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }]
  }))
  const ids = async (surfaces: RenderSurface[]) => {
    const input = {
      model: 'test',
      promptModel: 'test',
      surfaces,
      tools: [],
      outputStyle: null,
      traits: []
    }

    return (await $.prompt.compose(input)).sections.map((section) => section.id)
  }

  expect(await ids(['terminal'])).toContain('reply-markdown:forms')
  expect(await ids([])).not.toContain('reply-markdown:forms')
  expect(await ids(['desktop'])).not.toContain('reply-markdown:forms')
})

test('restyles nothing when turned off', { options: { enabled: false } }, async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, TEXT)

  expect(drawn).toEqual([TEXT])
  await ui.unmount()
})

test('tells Claude nothing when turned off', { options: { enabled: false } }, async ($, on) => {
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }]
  }))
  const surfaces: RenderSurface[] = ['terminal']
  const input = {
    model: 'test',
    promptModel: 'test',
    surfaces,
    tools: [],
    outputStyle: null,
    traits: []
  }

  expect((await $.prompt.compose(input)).sections.map((section) => section.id)).toEqual(['intro'])
})

test('a $$ formula is left whole to the mod beneath, a line of it like a list item too', async ($, on) => {
  const formula = '$$\na = b\n+ c\n- d\n$$'
  const drawn = engine(on)
  const ui = await mount($, `# Title\n\n${formula}\n\n- item`)

  expect(drawn).toEqual([formula])
  expect((await ui.findAll({ type: 'Markdown' })).map((markdown) => markdown.props.text)).toEqual([
    'item'
  ])
  await ui.unmount()
})

test('a ruled table of one row has the header line only', async ($, on) => {
  engine(on)
  const ui = await mount($, '| a | b |\n| - | - |\n| 1 | 2 |')
  const texts = (await ui.findAll({ type: 'Text' })).map((text) => text.text)

  // Two columns of one, three a column and one.
  expect(texts.filter((text) => /^[━─]+$/.test(text))).toEqual(['━'.repeat(9)])
  await ui.unmount()
})

test('an alert quote is a bordered callout, a task item a checkbox', async ($, on) => {
  engine(on)
  const ui = await mount($, '> [!WARNING]\n> Mind the **gap**.\n\n- [ ] todo\n- [x] done\n- plain')
  const label = await ui.find({ type: 'Text', text: 'Warning' })
  const boxes = await ui.findAll({ type: 'Box' })

  expect(label?.props).toMatchObject({ bold: true, color: '#f5ef34' })
  expect(
    boxes.some((box) => box.props.borderStyle === 'round' && box.props.borderColor === '#f5ef34')
  ).toBe(true)
  expect((await ui.findAll({ type: 'Markdown' })).map((markdown) => markdown.props.text)).toEqual([
    'Mind the **gap**.',
    'todo',
    'done',
    'plain'
  ])
  expect(await ui.find({ type: 'Text', text: '☐ ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '☑ ' }))?.props.color).toBe('#00ffb2')
  await ui.unmount()
})

const TABLE = ['| 名稱 | Note |', '| --- | ---: |', '| `ab` | a **bold** word |', '| c | d |'].join(
  '\n'
)

test('a table is ruled by default: a line under its header, a faint one between rows', async ($, on) => {
  engine(on)
  const ui = await mount($, TABLE)
  const texts = (await ui.findAll({ type: 'Text' })).map((text) => text.text)

  // Four columns for 名稱, eleven for `a bold word`, three a column and one.
  expect((await ui.find({ type: 'Text', text: '━'.repeat(22) }))?.props.color).toBe('#858392')
  expect((await ui.find({ type: 'Text', text: '─'.repeat(22) }))?.props.color).toBe('#4d4c57')
  // One line between the two rows, none above or below the table.
  expect(texts.filter((text) => /^[━─]+$/.test(text))).toHaveLength(2)
  expect(texts.some((text) => /[┃│┏╭]/.test(text))).toBe(false)
  await ui.unmount()
})

test(
  'a bold table is a heavy frame, its header colored, its cells markdown',
  { options: { tableBorder: 'bold' } },
  async ($, on) => {
    const drawn = engine(on)
    const ui = await mount($, `Before\n\n${TABLE}\n\nAfter`)
    const texts = (await ui.findAll({ type: 'Text' })).map((text) => text.text)

    // 名稱 is four columns wide, `a bold word` eleven.
    expect(texts).toContain('┏━━━━━━┳━━━━━━━━━━━━━┓')
    expect(texts).toContain('┣━━━━━━╋━━━━━━━━━━━━━┫')
    expect(texts).toContain('┗━━━━━━┻━━━━━━━━━━━━━┛')
    expect((await ui.find({ type: 'Text', text: '名稱' }))?.props).toMatchObject({ bold: true })
    expect((await ui.findAll({ type: 'Markdown' })).map((markdown) => markdown.props.text)).toEqual(
      ['`ab`', 'a **bold** word', 'c', 'd']
    )
    expect(drawn).toEqual(['Before', 'After'])
    await ui.unmount()
  }
)

test('a table too wide for the room is left to the engine', async ($, on) => {
  const wide = ['| one | two | three | four |', '| - | - | - | - |', '| 1 | 2 | 3 | 4 |'].join('\n')
  const drawn = engine(on, { maxProseWidth: 20 })
  const ui = await mount($, `# Title\n\n${wide}`)

  expect(drawn).toEqual([wide])
  await ui.unmount()
})

test('a code fence is a card with its language and a button that copies it', async ($, on) => {
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const drawn = engine(on)
  const ui = await mount($, 'Run it:\n\n```bash\nnpm test\n```\n\n```ts\nstill open')

  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({
    source: 'npm test',
    language: 'bash'
  })
  expect(await ui.find({ type: 'Text', text: 'bash' })).toBeDefined()
  // A fence the reply has not closed yet is the engine's still.
  expect(drawn).toEqual(['Run it:', '```ts\nstill open'])

  const [button] = await ui.findAll({ type: 'Button' })
  await ui.press({ key: String(button?.props.key) })
  expect(copied).toEqual(['npm test'])
  expect(toasts).toEqual(['Copied'])
  await ui.unmount()
})

test('the same code twice in a reply, and a fence the reply-media mod draws', async ($, on) => {
  const picture = '```mermaid\nflowchart LR\n  A --> B\n```'
  const drawn = engine(on)
  const code = '```mathematica\nPlot[Sin[x], {x, 0, 2 Pi}]\n```'
  const ui = await mount(
    $,
    `# Title\n\n\`\`\`sh\nls\n\`\`\`\n\n${picture}\n\n\`\`\`sh\nls\n\`\`\`\n\n${code}`
  )

  // `mathematica` only starts like `math`: it is code.
  expect((await ui.findAll({ type: 'Code' })).map((each) => each.props.language)).toEqual([
    'sh',
    'sh',
    'mathematica'
  ])
  // Left to whatever sits beneath: the reply-media mod, else the engine.
  expect(drawn).toEqual([picture])
  await ui.unmount()
})

test('a mermaid or math fence the reply-media mod cannot read is a code card', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount(
    $,
    '# Title\n\n````mermaid\nflowchart LR\n  A --> B\n````\n\n~~~math\nx^2\n~~~'
  )

  expect((await ui.findAll({ type: 'Code' })).map((each) => each.props.language)).toEqual([
    'mermaid',
    'math'
  ])
  expect(drawn).toEqual([])
  await ui.unmount()
})

test(
  'the borders follow the options',
  { options: { tableBorder: 'round', cardBorder: 'bold' } },
  async ($, on) => {
    engine(on)
    const ui = await mount($, `${TABLE}\n\n\`\`\`sh\nls\n\`\`\`\n\n> [!NOTE]\n> Mind it.`)
    const texts = (await ui.findAll({ type: 'Text' })).map((text) => text.text)
    const borders = (await ui.findAll({ type: 'Box' }))
      .map((box) => box.props.borderStyle)
      .filter(Boolean)

    expect(texts).toContain('╭──────┬─────────────╮')
    expect(texts).toContain('╰──────┴─────────────╯')
    expect(texts.some((text) => text.startsWith('│\n│'))).toBe(true)
    // The code card and the callout.
    expect(borders).toEqual(['bold', 'bold'])
    await ui.unmount()
  }
)

test(
  'a kind switched off goes back to the engine as markdown, joined to the text beside it',
  { options: { headings: false, lists: false } },
  async ($, on) => {
    const drawn = engine(on)
    const ui = await mount($, TEXT)

    expect(drawn).toEqual([
      'Intro paragraph.\n\n# Title\n## Section `one`\n- first **item**\n  wrapped line\n  - nested\n1. step'
    ])
    // The rule and the code card are still the mod's.
    expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.unmount()
  }
)

test(
  "with callouts off an alert is the engine's quote",
  { options: { callouts: false } },
  async ($, on) => {
    const drawn = engine(on)
    const ui = await mount($, '> [!WARNING]\n> Careful')

    expect(drawn).toEqual(['> [!WARNING]\n> Careful'])
    await ui.unmount()
  }
)

test(
  "with code cards off a fence is the engine's, its fence holding the backticks inside",
  { options: { codeCards: false } },
  async ($, on) => {
    const drawn = engine(on)
    const ui = await mount($, 'Run:\n\n````md\n```ts\nx\n```\n````\n\n## Next')

    expect(drawn).toEqual(['Run:\n\n````md\n```ts\nx\n```\n````'])
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  }
)

test('a form switched off is not told, and none is told with all three off', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const surfaces: RenderSurface[] = ['terminal']
  const input = {
    model: 'test',
    promptModel: 'test',
    surfaces,
    tools: [],
    outputStyle: null,
    traits: []
  }
  const text = (await $.prompt.compose(input)).sections.find(
    (section) => section.id === 'reply-markdown:forms'
  )?.text

  expect(text).toContain('GitHub alert')
  expect(text).toContain('task list')
  expect(text).toContain('copy button')
})

test(
  'with callouts, lists and code cards off, Claude is told no forms',
  { options: { callouts: false, lists: false, codeCards: false } },
  async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const surfaces: RenderSurface[] = ['terminal']
    const input = {
      model: 'test',
      promptModel: 'test',
      surfaces,
      tools: [],
      outputStyle: null,
      traits: []
    }

    expect((await $.prompt.compose(input)).sections.map((section) => section.id)).toEqual([])
  }
)

test('an unmatched $$ line keeps later headings, lists, tables, rules and code styled', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount(
    $,
    '$$\n\n# Title\n\n- item\n\n| A | B |\n|---|---|\n| one | two |\n\n---\n\n```ts\nconst value = 1\n```'
  )
  try {
    expect(await ui.find({ type: 'Text', text: ' Title ' })).toBeDefined()
    expect((await ui.findAll({ type: 'Markdown' })).map((item) => item.props.text)).toEqual([
      'item',
      'one',
      'two'
    ])
    expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('const value = 1')
    expect(drawn).toEqual(['$$'])
  } finally {
    await ui.unmount()
  }
})

test('a trailing unmatched $$ keeps earlier complete formulas whole and later blocks styled', async ($, on) => {
  const drawn = engine(on)
  const formula = '$$\na = b\n+ c\n- d\n$$'
  const ui = await mount($, `${formula}\n\n$$\n\n## Still styled\n\n> quoted\n\n- item`)
  try {
    expect(await ui.find({ type: 'Text', text: '▌ Still styled' })).toBeDefined()
    expect((await ui.findAll({ type: 'Markdown' })).map((item) => item.props.text)).toEqual([
      'quoted',
      'item'
    ])
    expect(drawn).toEqual([`${formula}\n\n$$`])
  } finally {
    await ui.unmount()
  }
})

for (const tableBorder of ['rules', 'round', 'single', 'bold']) {
  test(
    `a ${tableBorder} table copies its Markdown without surrounding prose`,
    { options: { tableBorder } },
    async ($, on) => {
      const source =
        '| 名称 | Note |\n| :--- | ---: |\n| `a\\|b` | **bold** and [link](https://example.com) |\n| c | ~~old~~ |'
      const copied: { text: string; surface: RenderSurface | undefined }[] = []
      const toasts: string[] = []
      on('ui.copy', (_, e) => {
        copied.push({ text: e.text, surface: e.surface })
        return { value: { isCopied: true as const } }
      })
      on('ui.toast', (_, e) => {
        toasts.push(e.text)
        return { value: undefined }
      })
      const drawn = engine(on)
      const ui = await mount($, `Before\n\n${source}\n\nAfter`)
      const buttons = await ui.findAll({ type: 'Button' })

      expect(buttons).toHaveLength(1)
      expect(buttons[0]?.props.label).toBe('copy')
      await ui.press({ key: String(buttons[0]?.props.key) })
      expect(copied).toEqual([{ text: source, surface: 'terminal' }])
      expect(toasts).toEqual(['Copied'])
      expect(drawn).toEqual(['Before', 'After'])
      await ui.unmount()
    }
  )
}

test('a table too wide to restyle still has a working copy button', async ($, on) => {
  const source = '| one | two | three | four |\n| - | - | - | - |\n| 1 | 2 | 3 | 4 |'
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const drawn = engine(on, { maxProseWidth: 20 })
  const ui = await mount($, `# Title\n\n${source}`)
  const buttons = await ui.findAll({ type: 'Button' })

  expect(drawn).toEqual([source])
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.props.label).toBe('copy')
  await ui.press({ key: String(buttons[0]?.props.key) })
  expect(copied).toEqual([source])
  await ui.unmount()
})

test('table and code buttons copy their own sources across repeated blocks', async ($, on) => {
  const first = '| A | B |\n| - | - |\n| 1 | 2 |'
  const second = '| C | D |\n| - | - |\n| 3 | 4 |'
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  engine(on)
  const ui = await mount($, `${first}\n\n\`\`\`sh\necho hello\n\`\`\`\n\n${second}\n\n${first}`)
  const buttons = await ui.findAll({ type: 'Button' })

  expect(buttons.map((button) => button.props.label)).toEqual(['copy', 'copy', 'copy', 'copy'])
  for (const button of buttons) {
    await ui.press({ key: String(button.props.key) })
  }
  expect(copied).toEqual([first, 'echo hello', second, first])
  await ui.unmount()
})

test('a failed table copy reports the clipboard failure', async ($, on) => {
  const toasts: string[] = []
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  engine(on)
  const ui = await mount($, TABLE)
  const buttons = await ui.findAll({ type: 'Button' })

  expect(buttons).toHaveLength(1)
  await ui.press({ key: String(buttons[0]?.props.key) })
  expect(toasts).toEqual(['Not copied: no-clipboard'])
  await ui.unmount()
})

test(
  'tables switched off do not gain a copy control',
  { options: { tables: false } },
  async ($, on) => {
    const drawn = engine(on)
    const ui = await mount($, TABLE)

    expect(drawn).toEqual([TABLE])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
)

for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
  test(`a ${kind} callout copies its complete Markdown without surrounding prose`, async ($, on) => {
    const source = `> [!${kind}]\n> 第一行 **bold** and \`code\`.\n> \n> Keep [the link](https://example.com) and ~~old text~~.`
    const copied: { text: string; surface: RenderSurface | undefined }[] = []
    const toasts: string[] = []
    on('ui.copy', (_, e) => {
      copied.push({ text: e.text, surface: e.surface })
      return { value: { isCopied: true as const } }
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const drawn = engine(on)
    const ui = await mount($, `Before\n\n${source}\n\nAfter`)
    const buttons = await ui.findAll({ type: 'Button' })

    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.props).toMatchObject({ label: 'copy', plain: true, dimColor: true })
    await ui.press({ key: String(buttons[0]?.props.key) })
    expect(copied).toEqual([{ text: source, surface: 'terminal' }])
    expect(toasts).toEqual(['Copied'])
    expect(drawn).toEqual(['Before', 'After'])
    expect((await ui.find({ type: 'Text', text: /^old text$/ }))?.props.strikethrough).toBe(true)
    await ui.unmount()
  })
}

test('repeated callouts, a table and a code card each copy their own block', async ($, on) => {
  const first = '> [!NOTE]\n> First note.'
  const second = '> [!WARNING]\n> Second note.'
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  engine(on)
  const ui = await mount(
    $,
    `${first}\n\n${TABLE}\n\n${second}\n\n\`\`\`sh\necho hello\n\`\`\`\n\n${first}`
  )
  const buttons = await ui.findAll({ type: 'Button' })

  expect(buttons).toHaveLength(5)
  expect(new Set(buttons.map((button) => button.props.key)).size).toBe(5)
  expect(buttons.map((button) => button.props.label)).toEqual([
    'copy',
    'copy',
    'copy',
    'copy',
    'copy'
  ])
  for (const button of buttons) {
    await ui.press({ key: String(button.props.key) })
  }
  expect(copied).toEqual([first, TABLE, second, 'echo hello', first])
  await ui.unmount()
})

test(
  'callouts switched off keep the quote without a copy control',
  { options: { callouts: false } },
  async ($, on) => {
    const source = '> [!NOTE]\n> An ordinary engine quote.'
    const drawn = engine(on)
    const ui = await mount($, source)

    expect(drawn).toEqual([source])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
)

test('a narrow callout retains its complete body and reports a failed copy', async ($, on) => {
  const toasts: string[] = []
  const source = '> [!IMPORTANT]\n> Long card text with 中文内容 and `code`.'
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  engine(on, { maxProseWidth: 14 })
  const ui = await $.ui.mount({
    plugin: 'reply-markdown',
    surface: 'terminal',
    component: 'AssistantMessage',
    viewport: { columns: 20, rows: 24 },
    props: { text: source, isFirstOfReply: true }
  })
  const buttons = await ui.findAll({ type: 'Button' })

  expect(buttons).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: 'Important' }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(
    'Long card text with 中文内容 and `code`.'
  )
  await ui.press({ key: String(buttons[0]?.props.key) })
  expect(toasts).toEqual(['Not copied: no-clipboard'])
  await ui.unmount()
})
