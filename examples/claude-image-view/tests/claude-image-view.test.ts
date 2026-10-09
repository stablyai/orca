import { expect, mock, test } from 'claude-code/testing'

import { fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'

function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(45)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], 33)
  return btoa(String.fromCharCode(...bytes))
}

test('image numbers come from the draft, deduplicated, in order', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
  expect(imageNumbers('[Image 1] [image #3] #4')).toEqual([])
})

test('PNG size is read from the IHDR header', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...'))).toBeNull()
})

test('thumbnails keep aspect ratio within the tile', () => {
  // Square: 6 rows tall, twice as many columns because cells are tall.
  expect(fitCells({ width: 500, height: 500 })).toEqual({ columns: 12, rows: 6 })
  // Very wide: capped at 32 columns, rows shrink to match.
  expect(fitCells({ width: 3000, height: 500 })).toEqual({ columns: 32, rows: 3 })
  // Very tall: never narrower than 4 columns.
  expect(fitCells({ width: 100, height: 2000 })).toEqual({ columns: 4, rows: 6 })
})

test('a row of tiles shrinks to fit the band so it never scrolls', () => {
  const square = { width: 500, height: 500 }
  // Plenty of room: full 6-row tiles.
  expect(fitRow([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // A short band: border and label take 3 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 8, rows: 4 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
  expect(fitRow([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 }
  ])
})

const BAND = {
  plugin: 'orca-image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
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

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1] [Image #2]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', () => ({
    value: [
      { name: '-other', kind: 'dir', ...entry },
      { name: 'notes.txt', kind: 'file', ...entry },
      { name: '-work', kind: 'dir', ...entry }
    ]
  }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.stat', ($, e) => {
    if (e.path !== `${dir}/1.png`) {
      throw new Error('ENOENT')
    }
    return { value: { kind: 'file', size: 33, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { png: pngHead(800, 400) }, columns: 24, rows: 6 })
  // #2 has no cached file, so it gets a placeholder tile instead of a broken Image.
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  expect(image?.props.source).not.toHaveProperty('file')
  await ui.unmount()

  // Sending the prompt empties the box.
  draft = ''
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

for (const scenario of ['oversized', 'symlink', 'invalid', 'missing'] as const) {
  test(`a ${scenario} image leaves a placeholder without file transport`, async ($, on) => {
    const clock = mock.clock(on)
    const dir = '/tmp/claude-501/-work/session/images'
    let reads = 0
    on('session.start', () => ({ cwd: '/work' }))
    on('prompt.read', () => ({ value: { text: '[Image #1]', cursor: 10 } }))
    on('env.get', () => ({ value: '/tmp/claude-501' }))
    on('session.id', () => ({ value: 'session' }))
    on('fs.list', () => ({
      value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
    }))
    on('fs.exists', ($, e) => ({ value: e.path === dir }))
    on('fs.stat', () => {
      if (scenario === 'missing') {
        throw new Error('ENOENT')
      }
      return {
        value: {
          kind: 'file',
          size: scenario === 'oversized' ? 2 * 1024 * 1024 + 1 : 33,
          mtimeMs: 0,
          isLink: scenario === 'symlink'
        }
      }
    })
    on('fs.read', () => {
      reads++
      return { value: { base64: btoa('not a PNG') } }
    })
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
    expect(reads).toBe(scenario === 'invalid' ? 1 : 0)
    await ui.unmount()
  })
}

test('a session switch rereads reused image numbers and draft deletion drops cached bytes', async ($, on) => {
  const clock = mock.clock(on)
  let session = 'first'
  let draft = '[Image #1]'
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: session }))
  on('fs.list', () => ({
    value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 33, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => {
    reads++
    return { value: { base64: pngHead(session === 'first' ? 800 : 400, 400) } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(400)
  expect(reads).toBe(1)
  session = 'second'
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({
    source: { png: pngHead(400, 400) }
  })
  await ui.unmount()
  expect(reads).toBe(2)
  draft = ''
  await clock.advance(200)
  draft = '[Image #1]'
  await clock.advance(200)
  expect(reads).toBe(3)
})
