import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const engine = (on: On) => {
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
}

test('a slow preview never holds the native append and updates its mounted row later', async ($, on) => {
  const clock = mock.clock(on)
  let returned = false
  let converted = false
  on('process.run', async () => {
    await clock.sleep(12_000)
    converted = true
    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  engine(on)
  const pending = $.session
    .append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: 'row-slow-preview',
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
    })
    .then((result) => {
      returned = true
      return result
    })
  const ui = await $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: TEXT, isFirstOfReply: true }
  })
  try {
    await clock.settle()
    expect(returned).toBe(true)
    expect(converted).toBe(false)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await clock.advance(12_000)
    const stored = await pending
    expect(stored.uuid).toBe('row-slow-preview')
    expect(stored.message?.content).toEqual([{ type: 'text', text: TEXT }])
    expect(converted).toBe(true)
    expect(await ui.find({ type: 'Image' })).toBeDefined()
  } finally {
    await clock.advance(12_000)
    await pending
    await ui.unmount()
  }
})

test('previews use the text committed by the remaining append hooks', async ($, on) => {
  const rendered: (string | undefined)[] = []
  const rewritten = TEXT.replace('A --> B', 'A --> C')
  const clock = mock.clock(on)
  engine(on)
  on('session.append', { door: 'response' }, (_, e, next) =>
    next({ ...e, message: { ...e.message, content: [{ type: 'text', text: rewritten }] } })
  )
  on('process.run', (_, e) => {
    rendered.push(e.init?.stdin)
    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  const stored = await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-rewritten-preview',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
  })
  await clock.settle()
  expect(stored.message?.content).toEqual([{ type: 'text', text: rewritten, citations: null }])
  expect(rendered).toEqual([SOURCE.replace('A --> B', 'A --> C')])
})
