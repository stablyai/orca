import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII='
const TEXT = 'Before\n\n![clip](clip.mp4)\n\nAfter'
const POSTER = '/tmp/cache-video-poster.png'
const OLD = '/tmp/cache-video-old'
const FRESH = '/tmp/cache-video-fresh'
const RAN = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false
}

for (const missing of ['first', 'last', 'neither']) {
  test(`replay with ${missing} cached frame missing keeps the poster and recuts only when needed`, async ($, on) => {
    const clock = mock.clock(on)
    let swept = false
    let cuts = 0
    let blits = 0
    const reads: string[] = []
    const stats: string[] = []
    const missingPath = `${OLD}/${missing === 'first' ? 'f00001.png' : 'f00003.png'}`
    on('session.cwd', () => ({ value: '/work' }))
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.stat', (_, e) => {
      stats.push(e.path)
      return swept && missing !== 'neither' && e.path === missingPath
        ? { deny: 'ENOENT: cached frame was swept' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    })
    on('fs.read', (_, e) => {
      reads.push(e.path)
      return { value: { base64: PNG } }
    })
    on('ui.blit', () => {
      blits++
      return { value: {} }
    })
    on('process.run', (_, e) => {
      const output =
        e.argv[2] === 'frames'
          ? { dir: ++cuts === 1 ? OLD : FRESH, count: 3, fps: 10 }
          : { file: POSTER, width: 100, height: 40, clip: '/work/clip.mp4' }
      return { value: { ...RAN, stdout: JSON.stringify(output) } }
    })
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: 'video-cache-replay',
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
    })
    await clock.settle()
    const mount = () =>
      $.ui.mount({
        plugin: 'reply-media',
        surface: 'terminal',
        component: 'AssistantMessage',
        props: { text: TEXT, isFirstOfReply: true }
      })
    const first = await mount()
    const key = String((await first.find({ type: 'Button', text: '▶ play' }))?.props.key)
    await first.press({ key })
    await clock.settle()
    await clock.advance(300)
    expect(cuts).toBe(1)
    expect(blits).toBe(3)
    await first.unmount()
    swept = true
    reads.length = 0
    stats.length = 0
    blits = 0
    const restored = await mount()
    try {
      expect(await restored.find({ type: 'Image' })).toBeDefined()
      expect(stats).toContain(POSTER)
      await restored.press({ key })
      await clock.settle()
      expect(cuts).toBe(missing === 'neither' ? 1 : 2)
      expect(await restored.find({ type: 'Button', text: '❚❚ pause' })).toBeDefined()
      reads.length = 0
      await clock.advance(300)
      const dir = missing === 'neither' ? OLD : FRESH
      expect(reads).toEqual(
        expect.arrayContaining([`${dir}/f00001.png`, `${dir}/f00002.png`, `${dir}/f00003.png`])
      )
      expect(reads.filter((path) => path.startsWith(`${dir === OLD ? FRESH : OLD}/`))).toEqual([])
      expect(blits).toBe(3)
      expect(await restored.find({ type: 'Button', text: '▶ play' })).toBeDefined()
    } finally {
      await restored.unmount()
    }
  })
}

test('cancelling during a missing-frame probe does not start another extraction', async ($, on) => {
  const clock = mock.clock(on)
  let swept = false
  let cuts = 0
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.stat', async (_, e) => {
    if (swept && e.path === `${OLD}/f00001.png`) {
      await clock.sleep(1_000)
      return { deny: 'ENOENT: cached frame was swept' }
    }
    return { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_, e) => {
    const output =
      e.argv[2] === 'frames'
        ? { dir: ++cuts === 1 ? OLD : FRESH, count: 3, fps: 10 }
        : { file: POSTER, width: 100, height: 40, clip: '/work/clip.mp4' }
    return { value: { ...RAN, stdout: JSON.stringify(output) } }
  })
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'video-cache-cancel',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
  })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: TEXT, isFirstOfReply: true }
  })
  try {
    const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
    await ui.press({ key })
    await clock.settle()
    await clock.advance(300)
    swept = true
    await ui.press({ key })
    await clock.settle()
    await ui.press({ key })
    await clock.advance(1_000)
    expect(cuts).toBe(1)
    expect(await ui.find({ type: 'Button', text: '▶ play' })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

for (const state of ['playing', 'preparing']) {
  for (const action of ['cancel', 'replace']) {
    test(`${action} during the final ${state} write cannot revive an old video`, async ($, on) => {
      const clock = mock.clock(on)
      const text = '![first](first.mp4)\n\n![second](second.mp4)'
      const blits: string[] = []
      let extracted = false
      let delayed = false
      on('session.cwd', () => ({ value: '/work' }))
      on('session.surfaces', () => ({ value: ['terminal'] }))
      on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
      on('ui.toast', () => ({ value: undefined }))
      on('fs.stat', () => ({
        value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false }
      }))
      on('fs.read', () => ({ value: { base64: PNG } }))
      on('ui.blit', (_, e) => {
        blits.push(e.key)
        return { value: {} }
      })
      on('process.run', (_, e) => {
        const first = e.init?.stdin?.includes('first') === true
        const name = first ? 'first' : 'second'
        if (e.argv[2] === 'frames' && first) {
          extracted = true
        }
        return {
          value: {
            ...RAN,
            stdout: JSON.stringify(
              e.argv[2] === 'frames'
                ? { dir: `/tmp/${name}-frames`, count: 30, fps: 10 }
                : {
                    file: `/tmp/${name}-poster.png`,
                    width: 100,
                    height: 40,
                    clip: `/work/${name}.mp4`
                  }
            )
          }
        }
      })
      on('state.set', { plugin: 'reply-media', key: state }, async (_, e, next) => {
        if (extracted && !delayed && (state === 'playing' || e.value === null)) {
          delayed = true
          await clock.sleep(1_000)
        }
        return next(e)
      })
      await $.session.append({
        door: 'response',
        origin: { kind: 'model', model: 'test' },
        uuid: `video-final-write-${state}-${action}`,
        message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
      })
      await clock.settle()
      const ui = await $.ui.mount({
        plugin: 'reply-media',
        surface: 'terminal',
        component: 'AssistantMessage',
        props: { text, isFirstOfReply: true }
      })
      try {
        const keys = (await ui.findAll({ type: 'Button', text: '▶ play' })).map((button) =>
          String(button.props.key)
        )
        expect(keys).toHaveLength(2)
        await ui.press({ key: keys[0] })
        await clock.settle()
        expect(delayed).toBe(true)
        expect(blits).toEqual([])
        await ui.press({ key: keys[action === 'cancel' ? 0 : 1] })
        await clock.settle()
        await clock.advance(1_000)
        await clock.advance(100)
        expect(await ui.find({ type: 'Button', text: 'cancel loading' })).toBeUndefined()
        if (action === 'cancel') {
          expect(blits).toEqual([])
          expect(await ui.findAll({ type: 'Button', text: '▶ play' })).toHaveLength(2)
          expect(await ui.find({ type: 'Button', text: '❚❚ pause' })).toBeUndefined()
        } else {
          expect(blits.length).toBeGreaterThan(0)
          expect(new Set(blits)).toEqual(new Set([keys[1].replace('play:', 'view:')]))
          expect((await ui.find({ type: 'Button', text: '❚❚ pause' }))?.props.key).toBe(keys[1])
          await ui.press({ key: keys[1] })
        }
      } finally {
        await ui.unmount()
      }
    })
  }
}

for (const action of ['play', 'cancel']) {
  test(`cached video ${action} refreshes protection before collection and keeps cancellation final`, async ($, on) => {
    const clock = mock.clock(on)
    let cuts = 0
    let refreshed = false
    let touching = false
    let swept = false
    let blits = 0
    on('session.cwd', () => ({ value: '/work' }))
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }))
    on('fs.read', (_, e) =>
      swept && e.path.startsWith(`${OLD}/`)
        ? { deny: 'ENOENT: collector removed unprotected cached frames' }
        : { value: { base64: PNG } }
    )
    on('ui.blit', () => {
      blits++
      return { value: {} }
    })
    on('process.run', async (_, e) => {
      if (e.argv[2] === 'touch') {
        touching = true
        if (action === 'cancel') {
          await clock.sleep(1_000)
        }
        refreshed = true
        return { value: { ...RAN, stdout: JSON.stringify({ dir: OLD }) } }
      }
      if (e.argv[2] === 'frames') {
        cuts++
        return { value: { ...RAN, stdout: JSON.stringify({ dir: OLD, count: 3, fps: 10 }) } }
      }
      return {
        value: {
          ...RAN,
          stdout: JSON.stringify({ file: POSTER, width: 100, height: 40, clip: '/work/clip.mp4' })
        }
      }
    })
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `cached-video-refresh-${action}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }
    })
    await clock.settle()
    const ui = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: TEXT, isFirstOfReply: true }
    })
    try {
      const key = String((await ui.find({ type: 'Button', text: '▶ play' }))?.props.key)
      await ui.press({ key })
      await clock.settle()
      await clock.advance(300)
      expect(blits).toBe(3)
      await clock.advance(16 * 60 * 1000)
      blits = 0
      await ui.press({ key })
      await clock.settle()
      if (action === 'cancel') {
        expect(touching).toBe(true)
        await ui.press({ key })
        await clock.advance(1_000)
      }
      swept = !refreshed
      await clock.advance(300)
      expect(cuts).toBe(1)
      expect(blits).toBe(action === 'play' ? 3 : 0)
      expect(await ui.find({ type: 'Button', text: '▶ play' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: 'cancel loading' })).toBeUndefined()
    } finally {
      await ui.unmount()
    }
  })
}
