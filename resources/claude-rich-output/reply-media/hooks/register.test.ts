import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII='

const SOURCE = 'flowchart LR\n  A --> B'
const TEXT = `Before\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter`
const DIAGRAM = { file: '/tmp/a.png', width: 800, height: 400 }
const RAN = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false
}

const clocks = new WeakMap<Engine, ReturnType<typeof mock.clock>>()
const clockFor = ($: Engine, on: On) => {
  let clock = clocks.get($)
  if (!clock) {
    clock = mock.clock(on)
    clocks.set($, clock)
  }
  return clock
}

/** Visual cases wait for optional background rendering, separately from the native append. */
const append = async ($: Engine, input: Parameters<Engine['session']['append']>[0]) => {
  const result = await $.session.append(input)
  await clocks.get($)?.settle()
  return result
}

/**
 * Stands for the engine beneath the mod: a session in /work drawn on a
 * terminal, and a record of the text it is asked to draw.
 */
const engine = ($: Engine, on: On, fileMocks = true) => {
  clockFor($, on)
  const drawn: string[] = []
  if (fileMocks) {
    on('fs.read', () => ({ value: { base64: PNG } }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
  }
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    drawn.push(e.props.text)

    return { type: 'engine', ref: 0 }
  })

  return drawn
}

/** Appends the reply as the model's, then draws its row on the terminal. */
const reply = async ($: Engine, uuid: string, text = TEXT) => {
  await append($, {
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid,
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text }]
    }
  })

  return $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true }
  })
}

for (const stdout of ['', '{broken', 'null', '[]']) {
  test(`invalid renderer output ${JSON.stringify(stdout)} preserves the reply and shows a retry`, async ($, on) => {
    on('process.run', () => ({ value: { ...RAN, stdout } }))
    const drawn = engine($, on)
    const ui = await reply($, `invalid-json-${stdout}`)
    expect(drawn).toEqual(['Before', 'After'])
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^✗ not drawn: renderer printed/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'retry' })).toBeDefined()
    await ui.unmount()
  })
}

for (const failure of ['stat', 'read']) {
  test(`a paused video survives its selected frame disappearing during ${failure}`, async ($, on) => {
    const clock = clockFor($, on)
    let swept = false
    const reads: string[] = []
    const poster = '/tmp/paused-poster.png'
    const gone = '/tmp/paused-frames/f00002.png'
    on('process.run', () => ({
      value: {
        ...RAN,
        stdout: JSON.stringify({
          ...DIAGRAM,
          file: poster,
          clip: '/work/paused.mp4',
          frames: { dir: '/tmp/paused-frames', count: 4, fps: 10 }
        })
      }
    }))
    engine($, on, false)
    on('fs.stat', (_, e) =>
      swept && e.path === gone && failure === 'stat'
        ? { deny: 'ENOENT: frame was swept' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    )
    on('fs.read', (_, e) => {
      reads.push(e.path)
      return swept && e.path === gone && failure === 'read'
        ? { deny: 'ENOENT: frame was swept after stat' }
        : { value: { base64: PNG } }
    })
    on('ui.blit', () => ({ value: {} }))
    const text = 'Before\n\n![paused](paused.mp4)\n\nAfter'
    const ui = await reply($, `paused-${failure}`, text)
    const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
    await ui.press({ key })
    await clock.settle()
    await clock.advance(200)
    await ui.press({ key })
    await ui.unmount()
    swept = true
    reads.length = 0
    const restored = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    expect(await restored.find({ type: 'Image' })).toBeDefined()
    expect(await restored.find({ type: 'Button', text: '▶ play' })).toBeDefined()
    expect(reads).toContain(poster)
    await restored.unmount()
  })

  test(`a playing video stops when a frame disappears during ${failure}`, async ($, on) => {
    const clock = clockFor($, on)
    let swept = false
    let blits = 0
    const gone = '/tmp/playing-frames/f00001.png'
    on('process.run', () => ({
      value: {
        ...RAN,
        stdout: JSON.stringify({
          ...DIAGRAM,
          file: '/tmp/playing-poster.png',
          clip: '/work/playing.mp4',
          frames: { dir: '/tmp/playing-frames', count: 4, fps: 10 }
        })
      }
    }))
    engine($, on, false)
    on('fs.stat', (_, e) =>
      swept && e.path === gone && failure === 'stat'
        ? { deny: 'ENOENT: frame was swept' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    )
    on('fs.read', (_, e) =>
      swept && e.path === gone && failure === 'read'
        ? { deny: 'ENOENT: frame was swept after stat' }
        : { value: { base64: PNG } }
    )
    on('ui.blit', () => {
      blits++
      return { value: {} }
    })
    const ui = await reply($, `playing-${failure}`, '![playing](playing.mp4)')
    const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
    await ui.press({ key })
    await clock.settle()
    expect(await ui.find({ type: 'Button', text: '❚❚ pause' })).toBeDefined()
    swept = true
    await clock.advance(100)
    expect(await ui.find({ type: 'Button', text: '▶ play' })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await clock.advance(500)
    expect(blits).toBe(0)
    await ui.unmount()
  })
}

test('a mermaid fence of a reply is drawn as an Image once rendered', async ($, on) => {
  const ran: (readonly string[])[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv)
    const diagram = { file: '/tmp/a.png', width: 800, height: 400 }

    return { value: { ...RAN, stdout: JSON.stringify(diagram) } }
  })
  const drawn = engine($, on)
  const ui = await reply($, 'row-1')
  const image = await ui.find({ type: 'Image' })

  expect(ran).toHaveLength(1)
  expect(ran[0]?.[1]).toMatch(/render\/render\.mjs$/)
  expect(drawn).toEqual(['Before', 'After'])
  expect(image?.props).toMatchObject({
    source: { png: PNG },
    columns: 76, // the 80-column default less its margin
    rows: 18,
    alt: SOURCE
  })
  // The engine draws the bullet, with the text the reply opens with.
  expect(await ui.find({ type: 'Text', text: '⏺ ' })).toBeUndefined()
  await ui.unmount()
})

test('a reply that opens with a picture has its bullet beside the picture', async ($, on) => {
  clockFor($, on)
  const firsts: boolean[] = []
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    firsts.push(e.props.isFirstOfReply === true)

    return { type: 'engine', ref: 0 }
  })
  on('process.run', () => ({ value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }))
  const ui = await reply($, 'row-opens', `\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter`)

  expect(await ui.find({ type: 'Text', text: '⏺ ' })).toBeDefined()
  // The text under it opens nothing: the engine draws no second bullet.
  expect(firsts).toEqual([false])
  await ui.unmount()
})

test('a fence that did not render is boxed in the error color, with its reason', async ($, on) => {
  // What node writes when a script throws: where, then the error, then its
  // stack. Two `Error:` when the tool the script ran says it too, as sips does.
  const stderr =
    'file:///mod/render/render.mjs:102\n  rasterize(\n  ^\n\nError: Error: bad diagram\n    at file:///mod/render/render.mjs:102:3\n'
  on('process.run', () => ({ value: { ...RAN, exitCode: 1, stderr } }))
  const drawn = engine($, on)
  const ui = await reply($, 'row-2')

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(drawn).toEqual(['Before', 'After'])
  expect(
    (await ui.find({ type: 'Text', text: /^✗ not drawn: bad diagram$/ }))?.props
  ).toMatchObject({
    color: 'error'
  })
  expect((await ui.findAll({ type: 'Box' })).some((box) => box.props.borderColor === 'error')).toBe(
    true
  )
  expect(await ui.find({ type: 'Text', text: SOURCE })).toBeDefined()
  await ui.unmount()
})

test('a picture whose file was swept is drawn again from its block', async ($, on) => {
  const clock = clockFor($, on)
  let ran = 0
  on('process.run', () => {
    // The reply's own render, then the one that makes the swept picture again.
    ran += 1
    const file = ran === 1 ? '/tmp/swept.png' : '/tmp/again.png'

    return { value: { ...RAN, stdout: JSON.stringify({ ...DIAGRAM, file }) } }
  })
  engine($, on, false)
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.stat', (_, e) =>
    e.path === '/tmp/swept.png'
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  )
  const ui = await reply($, 'row-swept')
  await clock.settle()

  expect(ran).toBe(2)
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ png: PNG })
  await ui.unmount()
})

test('a cached render failure can be retried after repairing the renderer', async ($, on) => {
  const clock = clockFor($, on)
  let calls = 0
  on('process.run', () => ({
    value:
      ++calls === 1
        ? { ...RAN, exitCode: 1, stderr: 'Error: XML parse error' }
        : { ...RAN, stdout: JSON.stringify(DIAGRAM) }
  }))
  engine($, on)
  const ui = await reply($, 'row-retry')
  const retry = await ui.find({ type: 'Button', text: 'retry' })
  expect(retry).toBeDefined()
  await ui.press({ key: String(retry?.props.key) })
  await clock.settle()
  expect(calls).toBe(2)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗ not drawn:/ })).toBeUndefined()
  await ui.unmount()
})

const source = (name: string) => `flowchart LR\n  ${name} --> Z`

test('a transient renderer timeout retries once with a cold-start budget', async ($, on) => {
  const budgets: (number | undefined)[] = []
  on('process.run', (_, e) => {
    budgets.push(e.init?.timeoutMs)
    if (budgets.length === 1) {
      return { deny: 'reply-media: $.process.run(node) aborted: still running after 30000ms' }
    }
    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  engine($, on)
  const ui = await reply($, 'transient-timeout')
  expect(budgets).toEqual([30_000, 30_000])
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗ not drawn:/ })).toBeUndefined()
})

test('repeated timeouts stop after two attempts and remain visible', async ($, on) => {
  let calls = 0
  on('process.run', () => {
    calls++
    return { deny: 'reply-media: $.process.run(node) aborted: still running after 30000ms' }
  })
  engine($, on)
  const ui = await reply($, 'persistent-timeout')
  expect(calls).toBe(2)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'retry' })).toBeDefined()
})

test('a genuine renderer error is not retried or hidden', async ($, on) => {
  let calls = 0
  on('process.run', () => {
    calls++
    return { value: { ...RAN, exitCode: 1, stderr: 'Error: Undefined control sequence' } }
  })
  engine($, on)
  const ui = await reply($, 'invalid-formula')
  expect(calls).toBe(1)
  expect(
    await ui.find({ type: 'Text', text: /not drawn: Undefined control sequence/ })
  ).toBeDefined()
})

test('the same block repeated within a reply is rendered only once', async ($, on) => {
  let calls = 0
  on('process.run', () => {
    calls++
    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  engine($, on)
  const ui = await reply($, 'duplicate-block', `${TEXT}\n\n${TEXT}`)
  expect(calls).toBe(1)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(2)
})

/**
 * Stands for a resumed session of four replies, each one diagram, and starts
 * it; answers the sources the mod rendered, in order.
 */
const resume = async ($: Engine, on: On, surface: 'terminal' | null = 'terminal') => {
  const rendered: (string | undefined)[] = []
  engine($, on)
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'draw them', toolUses: [] },
      ...['old', 'a', 'b', 'c'].map((name) => ({
        role: 'assistant' as const,
        text: `\`\`\`mermaid\n${source(name)}\n\`\`\``,
        toolUses: []
      }))
    ]
  }))
  on('process.run', (_, e) => {
    rendered.push(e.init?.stdin)

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface, isInteractive: surface !== null })

  return rendered
}

test('a resumed session gets pictures for its last three replies only', async ($, on) => {
  expect(await resume($, on)).toEqual(['a', 'b', 'c'].map(source))
})

test(
  'the number of replies redrawn on resume is an option',
  { options: { resumedReplies: 1 } },
  async ($, on) => {
    expect(await resume($, on)).toEqual([source('c')])
  }
)

test('zero redraws none', { options: { resumedReplies: 0 } }, async ($, on) => {
  expect(await resume($, on)).toEqual([])
})

test('a session resumed under -p redraws none', async ($, on) => {
  expect(await resume($, on, null)).toEqual([])
})

const MIXED = [
  'A formula:',
  '```math\n\\frac{a}{b}\n```',
  '$$\nE = mc^2\n$$',
  '![chart](plots/chart.png)',
  '```mathematica\nPlot[Sin[x], {x, 0, 2 Pi}]\n```',
  '```md\n![not drawn](inside/a/fence.png)\n```',
  '![remote](https://example.com/x.png)'
].join('\n\n')

/** Appends `text` as the model's reply, then draws its row on the terminal. */
const show = async ($: Engine, text: string) => {
  await append($, {
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-mixed',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
  })

  return $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true }
  })
}

test('formulas and local images are drawn too, each by its own script', async ($, on) => {
  const ran: [script: string | undefined, stdin: string | undefined, cwd: string | undefined][] = []
  on('process.run', (_, e) => {
    ran.push([e.argv[1]?.split('/').at(-1), e.init?.stdin, e.init?.cwd])

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  const drawn = engine($, on)
  const ui = await show($, MIXED)

  expect(ran).toEqual([
    ['math.mjs', '\\frac{a}{b}', '/work'],
    ['math.mjs', 'E = mc^2', '/work'],
    ['picture.mjs', 'plots/chart.png', '/work']
  ])
  expect((await ui.findAll({ type: 'Image' })).map((image) => image.props.alt)).toEqual([
    '\\frac{a}{b}',
    'E = mc^2',
    'plots/chart.png'
  ])
  // What is not drawn is the engine's, as written: the two fences that only
  // look like a formula or hold an image, and the remote image.
  expect(drawn.at(-1)).toBe(MIXED.split('\n\n').slice(-3).join('\n\n'))
  await ui.unmount()
})

test(
  'a picture is sized by the cell options',
  { options: { pxPerColumn: 16, cellAspect: 2 } },
  async ($, on) => {
    on('process.run', () => ({ value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }))
    engine($, on)
    const ui = await reply($, 'row-sized')

    // 800 px at 16 px a column is 50 columns, so 12.5 rows on cells twice as
    // tall as wide: 13 whole rows, and the 52 columns that keep the 2:1 shape.
    expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 52, rows: 13 })
    await ui.unmount()
  }
)

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

  expect(await ids(['terminal'])).toEqual(['intro', 'reply-media:forms'])
  expect(await ids([])).toEqual(['intro'])
  expect(await ids(['desktop'])).toEqual(['intro'])
})

test('renders nothing where no terminal draws, as under -p', async ($, on) => {
  clockFor($, on)
  const ran: (readonly string[])[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv)

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  on('session.surfaces', () => ({ value: [] }))
  await append($, {
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-headless',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
  })

  expect(ran).toEqual([])
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

test('a reply that opens with a block that failed has its bullet beside the box', async ($, on) => {
  on('process.run', () => ({ value: { ...RAN, exitCode: 1, stderr: 'Error: bad diagram' } }))
  engine($, on)
  const ui = await reply($, 'row-opens-failed', `\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter`)

  expect(await ui.find({ type: 'Text', text: '⏺ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✗ not drawn: bad diagram' })).toBeDefined()
  await ui.unmount()
})

test('a fence indented under a list item is left as text, not rendered', async ($, on) => {
  const ran: (readonly string[])[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv)

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  const drawn = engine($, on)
  const text = `- step\n  \`\`\`mermaid\n  ${SOURCE}\n  \`\`\``
  const ui = await reply($, 'row-indented', text)

  expect(ran).toEqual([])
  expect(drawn).toEqual([text])
  await ui.unmount()
})

test('draws nothing when turned off', { options: { enabled: false } }, async ($, on) => {
  const drawn = engine($, on)
  const ui = await reply($, 'row-off')

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(drawn).toEqual([TEXT])
  await ui.unmount()
})

test('a picture has buttons that copy its source and open it in a pane', async ($, on) => {
  const copied: string[] = []
  const opened: { id: string; closeOnEscape?: true }[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e)

    return { value: { isPlaced: true as const } }
  })
  on('process.run', () => {
    const diagram = { file: '/tmp/a.png', width: 800, height: 400 }

    return { value: { ...RAN, stdout: JSON.stringify(diagram) } }
  })
  engine($, on)
  const pane = (bodyColumns: number, bodyRows: number) =>
    $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'picture-zoom',
      props: {
        title: 'Picture',
        isFocused: false,
        bodyColumns,
        placement: 'dock',
        scroll: { offset: 0, bodyRows },
        view: {}
      }
    })
  const empty = await pane(60, 40)
  expect(await empty.find({ type: 'Image' })).toBeUndefined()
  await empty.unmount()

  const ui = await reply($, 'uuid-zoom')
  const keys = (await ui.findAll({ type: 'Button' })).map((button) => String(button.props.key))
  expect(keys.map((key) => key.split(':')[0])).toEqual(['copy', 'zoom'])

  await ui.press({ key: keys[0] ?? '' })
  expect(copied).toEqual([SOURCE])

  await ui.press({ key: keys[1] ?? '' })
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'picture-zoom', closeOnEscape: true })

  // As wide as the pane, or as tall as it when that comes first; 2:1 kept.
  const wide = await pane(60, 40)
  expect((await wide.find({ type: 'Image' }))?.props).toMatchObject({ columns: 60, rows: 14 })
  await wide.unmount()
  const short = await pane(120, 10)
  expect((await short.find({ type: 'Image' }))?.props).toMatchObject({ columns: 43, rows: 10 })
  await short.unmount()
  await ui.unmount()
})

test('a video is drawn as its first frame, and plays frame by frame once it is cut', async ($, on) => {
  const clock = clockFor($, on)
  const ran: (string | undefined)[][] = []
  const swapped: string[] = []
  on('process.run', (_, e) => {
    ran.push([e.argv[1]?.split('/').at(-1), ...e.argv.slice(2), e.init?.stdin])
    const printed =
      e.argv[2] === 'frames'
        ? { dir: '/tmp/clip', count: 3, fps: 10 }
        : { file: '/tmp/clip/f00001.png', width: 960, height: 540, clip: '/work/demo #1.mp4' }

    return { value: { ...RAN, stdout: JSON.stringify(printed) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    swapped.push('source' in e && 'png' in e.source ? e.source.png : '')

    return { value: {} }
  })
  engine($, on)
  const text = 'A recording:\n\n![demo](demo.mp4)'
  await append($, {
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-video',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
  })
  const ui = await $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'row-video',
    props: { text, isFirstOfReply: true }
  })
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map((button) => button.props)
  const play = String((await buttons())[0]?.key)

  // Only the first frame is made for the reply: the cut waits for a play.
  expect(ran).toEqual([['video.mjs', 'demo.mp4']])
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ png: PNG })
  expect((await buttons()).map((button) => button.label)).toEqual(['▶ play', 'copy path'])
  expect((await ui.find({ type: 'Link' }))?.props).toMatchObject({
    label: 'open file',
    href: '/work/demo #1.mp4'
  })

  await ui.press({ key: play })
  await clock.settle()
  expect(ran.at(-1)).toEqual(['video.mjs', 'frames', '/work/demo #1.mp4'])
  expect((await buttons())[0]?.label).toBe('❚❚ pause')

  // Three frames at ten a second, then it stops by itself.
  await clock.advance(300)
  expect(swapped).toEqual([PNG, PNG, PNG])
  expect((await buttons())[0]?.label).toBe('▶ play')

  // Played again from the start, without a second cut; a press pauses it,
  // and the next one goes on from the frame it stopped at.
  await ui.press({ key: play })
  await clock.settle()
  await clock.advance(200)
  await ui.press({ key: play })
  await clock.advance(300)
  expect(swapped.slice(3)).toEqual([PNG, PNG])
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ png: PNG })
  await ui.press({ key: play })
  await clock.settle()
  await clock.advance(200)
  expect(swapped.slice(5)).toEqual([PNG, PNG])
  expect(ran).toHaveLength(2)
  await ui.unmount()
})

test('a slow first video extraction returns the press and remains cancellable', async ($, on) => {
  const clock = clockFor($, on)
  let pressReturned = false
  let cuts = 0
  on('ui.press', async (_, e, next) => {
    const result = await next(e)
    pressReturned = true
    return result
  })
  on('process.run', async (_, e) => {
    if (e.argv[2] === 'frames') {
      cuts++
      await clock.sleep(12_000)
      return { value: { ...RAN, stdout: JSON.stringify({ dir: '/tmp/clip', count: 3, fps: 10 }) } }
    }
    return { value: { ...RAN, stdout: JSON.stringify({ ...DIAGRAM, clip: '/work/slow.mkv' }) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  engine($, on)
  const ui = await reply($, 'slow-video', '![slow](slow.mkv)')
  const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
  const pressed = ui.press({ key })
  await clock.settle()
  expect(pressReturned).toBe(true)
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('cancel loading')
  expect(cuts).toBe(1)
  const cancelled = ui.press({ key })
  await clock.settle()
  await clock.advance(12_000)
  await pressed
  await cancelled
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('▶ play')
  await ui.unmount()
})

test('a slow video starts after preparation without another press', async ($, on) => {
  const clock = clockFor($, on)
  let swaps = 0
  on('process.run', async (_, e) => {
    if (e.argv[2] === 'frames') {
      await clock.sleep(12_000)
      return { value: { ...RAN, stdout: JSON.stringify({ dir: '/tmp/clip', count: 3, fps: 10 }) } }
    }
    return { value: { ...RAN, stdout: JSON.stringify({ ...DIAGRAM, clip: '/work/slow.mkv' }) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', () => {
    swaps++
    return { value: {} }
  })
  engine($, on)
  const ui = await reply($, 'slow-plays', '![slow](slow.mkv)')
  const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
  const pressed = ui.press({ key })
  await clock.settle()
  await clock.advance(12_000)
  await pressed
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('❚❚ pause')
  await clock.advance(300)
  expect(swaps).toBe(3)
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('▶ play')
  await ui.unmount()
})

/** The forms note Claude is told on a terminal, or undefined when none is. */
const told = async ($: Engine) => {
  const surfaces: RenderSurface[] = ['terminal']
  const input = {
    model: 'test',
    promptModel: 'test',
    surfaces,
    tools: [],
    outputStyle: null,
    traits: []
  }

  return (await $.prompt.compose(input)).sections.find(
    (section) => section.id === 'reply-media:forms'
  )?.text
}

test(
  'a kind switched off stays text, and Claude is not told to write it',
  { options: { diagrams: false } },
  async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const ran: (readonly string[])[] = []
    on('process.run', (_, e) => {
      ran.push(e.argv)

      return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
    })
    const drawn = engine($, on)
    const ui = await reply($, 'row-diagrams-off')

    expect(ran).toEqual([])
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(drawn.at(-1)).toBe(TEXT)
    await ui.unmount()

    const text = await told($)
    expect(text).not.toContain('Diagrams:')
    expect(text).toContain('Math:')
    expect(text).toContain('Images:')
  }
)

test(
  'with every kind off, Claude is told nothing',
  { options: { diagrams: false, math: false, images: false, videos: false } },
  async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))

    expect(await told($)).toBeUndefined()
  }
)

test('videos alone are told as their own form', { options: { images: false } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const text = (await told($)) ?? ''

  expect(text).toContain('To show a video file')
  expect(text).not.toContain('To show an image file')
  expect(text).not.toContain('SVG')
})

test(
  'the buttons under a picture can be switched off',
  { options: { buttons: false } },
  async ($, on) => {
    on('process.run', () => ({ value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }))
    engine($, on)
    const ui = await reply($, 'row-no-buttons')

    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
)

test('PNG bytes travel inline, while files above the engine limit use file transport', async ($, on) => {
  engine($, on, false)
  on('process.run', () => ({ value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }))
  let size = 68
  on('fs.stat', () => ({ value: { kind: 'file' as const, size, mtimeMs: 0, isLink: false } }))
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: { base64: PNG } }
  })
  const small = await reply($, 'inline-small')
  expect((await small.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  expect(reads).toEqual(['/tmp/a.png'])
  await small.unmount()
  size = 2 * 1024 * 1024 + 1
  const large = await reply($, 'inline-large')
  expect((await large.find({ type: 'Image' }))?.props.source).toEqual({
    file: '/tmp/a.png',
    format: 'png'
  })
  expect(reads).toEqual(['/tmp/a.png'])
  await large.unmount()
})
