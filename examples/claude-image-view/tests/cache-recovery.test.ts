import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPQ0PjwHwAD/AJA63QQFQAAAABJRU5ErkJggg=='
const BAND = {
  plugin: 'orca-image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {}
  }
} as const

for (const failure of [
  'empty',
  'truncated',
  'header-only',
  'invalid',
  'unreadable',
  'missing',
  'oversized',
  'symlink'
] as const) {
  test(`${failure} PNG recovers without editing the draft and retries are throttled`, async ($, on) => {
    const clock = mock.clock(on)
    const draft = 'unchanged [Image #1]'
    let ready = false
    let stats = 0
    let reads = 0
    let redraws = 0
    let edits = 0
    on('session.start', () => ({ cwd: '/work' }))
    on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
    on('prompt.edit', async ($, e, next) => {
      edits++
      return next(e)
    })
    on('env.get', () => ({ value: '/tmp/claude-501' }))
    on('session.id', () => ({ value: 'session' }))
    on('fs.list', () => ({
      value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
    }))
    on('fs.exists', () => ({ value: true }))
    on('fs.stat', () => {
      stats++
      if (!ready && failure === 'missing') {
        throw new Error('ENOENT')
      }
      return {
        value: {
          kind: 'file',
          size: !ready && failure === 'oversized' ? 2 * 1024 * 1024 + 1 : 70,
          mtimeMs: 0,
          isLink: !ready && failure === 'symlink'
        }
      }
    })
    on('fs.read', () => {
      reads++
      if (!ready && failure === 'unreadable') {
        throw new Error('EACCES')
      }
      return {
        value: {
          base64: ready
            ? PNG
            : failure === 'empty'
              ? ''
              : failure === 'truncated'
                ? PNG.slice(0, 16)
                : failure === 'header-only'
                  ? PNG.slice(0, 48)
                  : btoa('invalid PNG')
        }
      }
    })
    on('ui.invalidate', async ($, e, next) => {
      redraws++
      return next(e)
    })
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
    const unchangedRedraws = redraws
    await clock.advance(1000)
    expect(redraws).toBe(unchangedRedraws)
    // One initial attempt plus one retry in a second, including thrown reads/stats.
    const failedStats = stats
    const failedReads = reads

    ready = true
    await clock.advance(1000)
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
    expect(failedStats).toBe(2)
    expect(failedReads).toBe(['missing', 'oversized', 'symlink'].includes(failure) ? 0 : 2)
    expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeUndefined()
    expect(redraws).toBeGreaterThan(unchangedRedraws)
    const successfulReads = reads
    await clock.advance(2000)
    expect(reads).toBe(successfulReads)
    expect(edits).toBe(0)
    await ui.unmount()
  })
}

test('removing an unavailable image or switching sessions discards its retry delay', async ($, on) => {
  const clock = mock.clock(on)
  let session = 'first'
  let draft = '[Image #1]'
  let ready = false
  const paths: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: session }))
  on('fs.list', () => ({
    value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 70, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => {
    paths.push(e.path)
    return { value: { base64: ready ? PNG : '' } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount(BAND)
  draft = ''
  await clock.advance(200)
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeUndefined()
  ready = true
  draft = '[Image #1]'
  await clock.advance(200)
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  expect(paths.length).toBe(2)

  ready = false
  session = 'second'
  await clock.advance(200)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  ready = true
  session = 'third'
  await clock.advance(200)
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
  expect(paths).toEqual([
    '/tmp/claude-501/-work/first/images/1.png',
    '/tmp/claude-501/-work/first/images/1.png',
    '/tmp/claude-501/-work/second/images/1.png',
    '/tmp/claude-501/-work/third/images/1.png'
  ])
  await ui.unmount()
})

test('multiple images retry independently, keep four entries and fit a narrow band', async ($, on) => {
  const clock = mock.clock(on)
  let draft = '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5]'
  let ready = false
  const reads = new Map<number, number>()
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'session' }))
  on('fs.list', () => ({
    value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 70, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => {
    const n = Number(e.path.match(/(\d+)\.png$/)?.[1])
    reads.set(n, (reads.get(n) ?? 0) + 1)
    return { value: { base64: n === 2 && !ready ? '' : PNG } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2200)
  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  expect([...reads]).toEqual([
    [1, 1],
    [2, 3],
    [3, 1],
    [4, 1]
  ])
  ready = true
  await clock.advance(1000)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(4)
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeUndefined()
  draft = '[Image #2] [Image #5]'
  await clock.advance(200)
  expect((await ui.findAll({ type: 'Image' })).map((image) => image.props.alt)).toEqual([
    '[Image #2]',
    '[Image #5]'
  ])
  draft = '[Image #1] [Image #2]'
  await clock.advance(200)
  expect(reads.get(1)).toBe(2)
  expect(reads.get(2)).toBe(4)
  await ui.unmount()
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 6, maxRows: 4 } })
  expect(await narrow.findAll({ type: 'Image' })).toHaveLength(1)
  expect((await narrow.find({ type: 'Image' }))?.props).toMatchObject({ columns: 4, rows: 1 })
  await narrow.unmount()
})
