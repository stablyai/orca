import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII='

for (const failure of ['stat permission', 'read permission', 'read disappeared']) {
  test(`zoom shows a fallback after a ${failure} failure`, async ($, on) => {
    const clock = mock.clock(on)
    const text = '```math\nx^2\n```'
    let armed = false
    on('session.cwd', () => ({ value: '/work' }))
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('fs.stat', () =>
      armed && failure === 'stat permission'
        ? { deny: 'EACCES: image stat denied' }
        : { value: { kind: 'file' as const, size: 68, mtimeMs: 0, isLink: false } }
    )
    on('fs.read', () =>
      armed && failure !== 'stat permission'
        ? {
            deny: failure === 'read disappeared' ? 'ENOENT: image was swept' : 'EACCES: read denied'
          }
        : { value: { base64: PNG } }
    )
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ file: '/tmp/zoom.png', width: 100, height: 40 }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false
      }
    }))
    on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: failure,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }
    })
    await clock.settle()
    const row = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true }
    })
    try {
      expect(await row.find({ type: 'Image' })).toBeDefined()
      const zoom = await row.find({ type: 'Button', text: 'zoom' })
      expect(zoom).toBeDefined()
      await row.press({ key: String(zoom?.props.key) })
    } finally {
      await row.unmount()
    }
    armed = true
    const pane = await $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'picture-zoom',
      props: {
        title: 'Picture',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 24 },
        view: {}
      }
    })
    try {
      expect(await pane.find({ type: 'Image' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: 'No picture to show.' })).toBeDefined()
    } finally {
      await pane.unmount()
    }
  })
}
