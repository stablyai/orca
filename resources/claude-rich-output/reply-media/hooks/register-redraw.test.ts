import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII='

for (const mode of ['swept picture', 'retry button']) {
  test(`${mode} reports failed background metadata without rejecting the UI`, async ($, on) => {
    const clock = mock.clock(on)
    const text = '```math\nx^2\n```'
    const toasts: string[] = []
    const drawn: string[] = []
    let unavailable = false
    on('session.cwd', () =>
      unavailable ? { deny: 'context metadata unavailable' } : { value: '/work' }
    )
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('fs.stat', () =>
      unavailable
        ? { deny: 'ENOENT: image was swept' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    )
    on('fs.read', () => ({ value: { base64: PNG } }))
    on('process.run', () => ({
      value: {
        exitCode: mode === 'retry button' ? 1 : 0,
        stdout: JSON.stringify({ file: '/tmp/redraw.png', width: 100, height: 40 }),
        stderr: mode === 'retry button' ? 'initial render unavailable' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false
      }
    }))
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
      drawn.push(e.props.text)
      return { type: 'engine', ref: 0 }
    })
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: mode,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    const mount = () =>
      $.ui.mount({
        plugin: 'reply-media',
        surface: 'terminal',
        component: 'AssistantMessage',
        props: { text, isFirstOfReply: true }
      })
    const first = await mount()
    if (mode === 'swept picture') {
      expect(await first.find({ type: 'Image' })).toBeDefined()
      await first.unmount()
      unavailable = true
      const restored = await mount()
      try {
        await clock.settle()
        expect(await restored.find({ type: 'Image' })).toBeUndefined()
        expect(drawn).toContain(text)
      } finally {
        await restored.unmount()
      }
    } else {
      try {
        const retry = await first.find({ type: 'Button', text: 'retry' })
        expect(retry).toBeDefined()
        unavailable = true
        await first.press({ key: String(retry?.props.key) })
        await clock.settle()
        expect(await first.find({ type: 'Text', text: 'initial render unavailable' })).toBeDefined()
      } finally {
        await first.unmount()
      }
    }
    expect(toasts).toEqual([expect.stringContaining('Media preview failed:')])
    expect(toasts[0]).toContain('context metadata unavailable')
  })
}

for (const failure of ['temporary', 'persistent']) {
  test(`swept preview retries a ${failure} metadata failure once without a redraw loop`, async ($, on) => {
    const clock = mock.clock(on)
    const text = '```math\nx^2\n```'
    const toasts: string[] = []
    const drawn: string[] = []
    let unavailable = false
    let swept = false
    let cwdCalls = 0
    let renders = 0
    on('session.cwd', () => {
      cwdCalls++
      return unavailable ? { deny: 'preview metadata unavailable' } : { value: '/work' }
    })
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('fs.stat', (_, e) =>
      swept && e.path === '/tmp/first.png'
        ? { deny: 'ENOENT: initial preview was swept' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    )
    on('fs.read', () => ({ value: { base64: PNG } }))
    on('process.run', () => {
      const file = ++renders === 1 ? '/tmp/first.png' : '/tmp/recovered.png'
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ file, width: 100, height: 40 }),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false
        }
      }
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
      drawn.push(e.props.text)
      return { type: 'engine', ref: 0 }
    })
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `redraw-${failure}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    const mount = () =>
      $.ui.mount({
        plugin: 'reply-media',
        surface: 'terminal',
        component: 'AssistantMessage',
        props: { text, isFirstOfReply: true }
      })
    const first = await mount()
    try {
      expect(await first.find({ type: 'Image' })).toBeDefined()
    } finally {
      await first.unmount()
    }
    expect(renders).toBe(1)
    expect(cwdCalls).toBe(1)
    swept = true
    unavailable = true
    const failed = await mount()
    try {
      await clock.settle()
      expect(await failed.find({ type: 'Image' })).toBeUndefined()
      expect(drawn).toContain(text)
      expect(toasts).toEqual([expect.stringContaining('preview metadata unavailable')])
    } finally {
      await failed.unmount()
    }
    unavailable = failure === 'persistent'
    const recovery = await mount()
    try {
      await clock.settle()
      expect(cwdCalls).toBe(3)
      if (failure === 'temporary') {
        expect((await recovery.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
        expect(renders).toBe(2)
        expect(toasts).toHaveLength(1)
      } else {
        expect(await recovery.find({ type: 'Image' })).toBeUndefined()
        expect(renders).toBe(1)
        expect(toasts).toHaveLength(2)
      }
    } finally {
      await recovery.unmount()
    }
    for (let index = 0; index < 6; index++) {
      const repainted = await mount()
      try {
        await clock.settle()
        expect(cwdCalls).toBe(3)
        if (failure === 'persistent') {
          expect(await repainted.find({ type: 'Image' })).toBeUndefined()
        } else {
          expect(await repainted.find({ type: 'Image' })).toBeDefined()
        }
      } finally {
        await repainted.unmount()
      }
    }
    expect(renders).toBe(failure === 'temporary' ? 2 : 1)
    expect(toasts).toHaveLength(failure === 'temporary' ? 1 : 2)
  })
}

test('a successfully recovered preview can recover again after another sweep', async ($, on) => {
  const clock = mock.clock(on)
  const text = '```math\nx^3 + 1\n```'
  const swept = new Set<string>()
  let renders = 0
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('fs.stat', (_, e) =>
    swept.has(e.path)
      ? { deny: 'ENOENT: preview was swept again' }
      : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
  )
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ file: `/tmp/preview-${++renders}.png`, width: 100, height: 40 }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false
    }
  }))
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'repeated-successful-redraw',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
  })
  await clock.settle()
  for (let cycle = 1; cycle <= 3; cycle++) {
    const mounted = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      await clock.settle()
      expect(await mounted.find({ type: 'Image' })).toBeDefined()
      expect(renders).toBe(cycle)
    } finally {
      await mounted.unmount()
    }
    swept.add(`/tmp/preview-${cycle}.png`)
  }
})
