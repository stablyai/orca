import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

function setup() {
  const openExternal = vi.fn().mockResolvedValue({ opened: true })
  const run = vi.fn().mockResolvedValue(undefined)
  let click: (() => void) | undefined
  const dispatchPluginNotification = vi.fn(async (input: { onClick?: () => void }) => {
    click = input.onClick
    return { delivered: true }
  })
  const services = pluginHostTestServices(null, {
    dispatchPluginNotification,
    desktop: { openExternal, confirm: vi.fn(), saveFile: vi.fn() },
    commands: { owns: (id) => id === 'demo.open', run }
  })
  const show = (onClick: unknown) =>
    callPluginHost({
      method: 'notifications.show',
      params: { title: 'Build done', onClick },
      granted: ['notifications:show'],
      services
    })
  return { show, openExternal, run, click: () => click?.() }
}

describe('notifications.show onClick', () => {
  it('opens the http(s) URL through the consented external open on click', async () => {
    const { show, openExternal, click } = setup()
    expect((await show({ url: 'https://example.com/run/1' })).ok).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
    click()
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        'samples.demo',
        'https://example.com/run/1',
        expect.anything()
      )
    )
  })

  it("runs the plugin's own command on click", async () => {
    const { show, run, click } = setup()
    expect((await show({ command: 'demo.open' })).ok).toBe(true)
    click()
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('samples.demo', 'demo.open'))
  })

  it.each([
    { url: 'file:///etc/passwd' },
    { url: 'javascript:alert(1)' },
    { url: 'mailto:a@example.com' },
    { command: 'other.plugin.command' }
  ])('refuses %o', async (onClick) => {
    const { show } = setup()
    expect(await show(onClick)).toMatchObject({ ok: false, code: 'invalid_params' })
  })
})
