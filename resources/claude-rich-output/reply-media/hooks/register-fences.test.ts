import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII='

for (const sample of [
  {
    name: 'long backtick example',
    lines: ['````md', '```math', 'example-formula', '```', '````']
  },
  {
    name: 'tilde example',
    lines: ['~~~md', '```math', 'example-formula', '```', '~~~']
  },
  {
    name: 'formula delimiters inside a tilde example',
    lines: ['~~~md', '$$', 'example-formula', '$$', '~~~']
  },
  {
    name: 'image inside a long tilde example',
    lines: ['~~~~md', '![example](example.png)', '~~~', '~~~~']
  }
]) {
  test(`a ${sample.name} stays literal without hiding the next formula`, async ($, on) => {
    const clock = mock.clock(on)
    const converted: (string | undefined)[] = []
    const drawn: string[] = []
    const example = sample.lines.join('\n')
    const text = `Before\n\n${example}\n\n\`\`\`math\nreal-formula\n\`\`\`\n\nAfter`
    on('session.cwd', () => ({ value: '/work' }))
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('fs.read', () => ({ value: { base64: PNG } }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
    on('process.run', (_, e) => {
      converted.push(e.init?.stdin)
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ file: '/tmp/formula.png', width: 100, height: 40 }),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false
        }
      }
    })
    on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
      drawn.push(e.props.text)
      return { type: 'engine', ref: 0 }
    })
    const stored = await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: sample.name,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    expect(stored.message?.content?.[0]?.text).toBe(text)
    expect(converted).toEqual(['real-formula'])
    const ui = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      expect((await ui.find({ type: 'Image' }))?.props.alt).toBe('real-formula')
      expect(drawn).toEqual([`Before\n\n${example}`, 'After'])
    } finally {
      await ui.unmount()
    }
  })
}

function mediaScenario(on: On) {
  const clock = mock.clock(on)
  const converted: [string | undefined, string | undefined][] = []
  const drawn: string[] = []
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
  on('process.run', (_, e) => {
    converted.push([e.argv[1]?.split('/').at(-1), e.init?.stdin])
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ file: '/tmp/media.png', width: 100, height: 40 }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false
      }
    }
  })
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    drawn.push(e.props.text)
    return { type: 'engine', ref: 0 }
  })
  return { clock, converted, drawn }
}

for (const sample of [
  {
    name: 'diagram',
    block: '```mermaid\nflowchart LR\nA --> B\n```',
    script: 'render.mjs',
    source: 'flowchart LR\nA --> B'
  },
  { name: 'formula', block: '```math\nx^2\n```', script: 'math.mjs', source: 'x^2' },
  { name: 'image', block: '![kept](kept.png)', script: 'picture.mjs', source: 'kept.png' }
]) {
  test(`inline backticks preserve the next ${sample.name}`, async ($, on) => {
    const { clock, converted, drawn } = mediaScenario(on)
    const prose = '```npm install``` then run setup.'
    const text = `${prose}\n\n${sample.block}\n\nAfter`
    const stored = await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `inline-backticks-${sample.name}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    expect(stored.message?.content?.[0]?.text).toBe(text)
    expect(converted).toEqual([[sample.script, sample.source]])
    const ui = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      expect((await ui.find({ type: 'Image' }))?.props.alt).toBe(sample.source)
      expect(drawn).toEqual([prose, 'After'])
    } finally {
      await ui.unmount()
    }
  })
}

for (const sample of [
  {
    name: 'diagram',
    block: '```mermaid\nflowchart LR\nA --> B\n```',
    script: 'render.mjs',
    source: 'flowchart LR\nA --> B'
  },
  { name: 'formula', block: '```math\nx^2\n```', script: 'math.mjs', source: 'x^2' },
  { name: 'local image', block: '![kept](kept.png)', script: 'picture.mjs', source: 'kept.png' }
]) {
  test(`an unclosed dollar delimiter preserves prose and the next ${sample.name}`, async ($, on) => {
    const { clock, converted, drawn } = mediaScenario(on)
    const text = `Before\n\n$$\n\n${sample.block}\n\nAfter`
    const stored = await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `unclosed-dollar-${sample.name}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    expect(stored.message?.content?.[0]?.text).toBe(text)
    expect(converted).toEqual([[sample.script, sample.source]])
    const ui = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      expect((await ui.find({ type: 'Image' }))?.props.alt).toBe(sample.source)
      expect(drawn).toEqual(['Before\n\n$$', 'After'])
    } finally {
      await ui.unmount()
    }
  })
}

test('an unclosed code fence still shields later formula and image syntax', async ($, on) => {
  const { clock, converted, drawn } = mediaScenario(on)
  const text = 'Before\n\n````md\n$$\n\n```math\nx^2\n```\n\n![literal](literal.png)\n\nAfter'
  const stored = await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'unclosed-code-fence',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
  })
  await clock.settle()
  expect(stored.message?.content?.[0]?.text).toBe(text)
  expect(converted).toEqual([])
  const ui = await $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true }
  })
  try {
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(drawn).toEqual([text])
  } finally {
    await ui.unmount()
  }
})

for (const fence of ['```', '````', '~~~']) {
  test(`an unmatched dollar line leaves a ${fence} example literal and renders all later media`, async ($, on) => {
    const { clock, converted, drawn } = mediaScenario(on)
    const example = `${fence}latex\n$$\nexample-formula\n$$\n${fence}`
    const diagram = 'flowchart LR\nA --> B'
    const text = `Before\n\n$$\n\n${example}\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n\`\`\`math\nx^2\n\`\`\`\n\n![kept](kept.png)\n\nAfter`
    const stored = await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `unmatched-dollar-code-example-${fence}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    expect(stored.message?.content?.[0]?.text).toBe(text)
    expect(converted).toEqual([
      ['render.mjs', diagram],
      ['math.mjs', 'x^2'],
      ['picture.mjs', 'kept.png']
    ])
    const ui = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      expect((await ui.findAll({ type: 'Image' })).map((image) => image.props.alt)).toEqual([
        diagram,
        'x^2',
        'kept.png'
      ])
      expect(drawn).toEqual([`Before\n\n$$\n\n${example}`, 'After'])
    } finally {
      await ui.unmount()
    }
  })
}
