import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import { runWithRemoteCliPageAdmission } from './remote-cli-page-admission'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { releaseHeldPageInput } from './guest-direct-key-input'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  mockAsWebContents,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

const PAGE_ID = 7
const REVOKED = 'The Orca desktop stopped sharing its browser before this command ran.'

function keyUps(mock: MockWebContents): string[] {
  return [
    ...mock.webContents.sendInputEvent.mock.calls.map((call) => call[0].type),
    ...mock.webContents.debugger.sendCommand.mock.calls
      .filter((call) => call[0] === 'Input.dispatchKeyEvent')
      .map((call) => String(call[1]?.type))
  ].filter((type) => type === 'keyUp')
}

function mouseEvents(mock: MockWebContents): string[] {
  return mock.webContents.debugger.sendCommand.mock.calls
    .filter((call) => call[0] === 'Input.dispatchMouseEvent')
    .map((call) => String(call[1]?.type))
}

describe('CdpWsProxy under a host command', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string
  let guardFocus: () => Promise<() => void>

  beforeEach(async () => {
    mock = createMockWebContents()
    guardFocus = async () => () => {}
    proxy = new CdpWsProxy(
      mockAsWebContents(mock, PAGE_ID),
      () => () => {},
      () => guardFocus()
    )
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('refuses every helper step after the host is revoked, without sending it to the page', async () => {
    let revoked = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (revoked) {
          throw new Error(REVOKED)
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const client = await connect(endpoint)
    const press = { type: 'mouseMoved', x: 1, y: 1 }

    const allowed = await sendAndReceive(client, {
      id: 1,
      method: 'Input.dispatchMouseEvent',
      params: press
    })
    revoked = true
    const refused = await sendAndReceive(client, {
      id: 2,
      method: 'Input.dispatchMouseEvent',
      params: press
    })

    expect(allowed.error).toBeUndefined()
    expect(refused).toMatchObject({ id: 2, error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual(['mouseMoved'])
    finish()
    await held
    client.close()
  })

  it('refuses a helper the PDF of a page that moved to a desktop file while it printed', async () => {
    let movedToFile = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (movedToFile) {
          throw new Error('not browsing through the host')
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    mock.webContents.printToPDF.mockImplementation(async () => {
      movedToFile = true
      return Buffer.from('%PDF-private')
    })
    const client = await connect(endpoint)

    const printed = await sendAndReceive(client, { id: 1, method: 'Page.printToPDF', params: {} })

    expect(printed).toMatchObject({ id: 1, error: { message: 'not browsing through the host' } })
    finish()
    await held
    client.close()
  })

  function holdPage(): { revoke: () => void; release: () => Promise<void> } {
    const page = mockAsWebContents(mock, PAGE_ID)
    let revoked = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (revoked) {
          throw new Error(REVOKED)
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve)),
      { releaseHeld: (release) => releaseHeldPageInput(page, release, () => guardFocus()) }
    )
    return {
      revoke: () => (revoked = true),
      release: async () => {
        finish()
        await held
      }
    }
  }

  const MOUSE = 'Input.dispatchMouseEvent'
  const KEY = 'Input.dispatchKeyEvent'
  const pressed = { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }
  const released = { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }
  const shiftDown = { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 }
  const shiftUp = { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }

  it.each(['window', 'webview'])(
    'refuses a revoked release, then lets go of the button and key itself (%s page)',
    async (pageType) => {
      mock.webContents.getType.mockReturnValue(pageType)
      const page = holdPage()
      const client = await connect(endpoint)

      await sendAndReceive(client, { id: 5, method: MOUSE, params: pressed })
      await sendAndReceive(client, { id: 6, method: KEY, params: shiftDown })
      page.revoke()
      const mouseUp = await sendAndReceive(client, { id: 7, method: MOUSE, params: released })
      const keyUp = await sendAndReceive(client, { id: 8, method: KEY, params: shiftUp })

      expect(mouseUp).toMatchObject({ error: { message: REVOKED } })
      expect(keyUp).toMatchObject({ error: { message: REVOKED } })
      expect(mouseEvents(mock)).toEqual(['mousePressed'])
      expect(keyUps(mock)).toHaveLength(0)
      await page.release()
      // Release off-page to avoid completing the revoked click.
      expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith(
        MOUSE,
        expect.objectContaining({ type: 'mouseReleased', x: -1, y: -1 })
      )
      expect(mouseEvents(mock)).toEqual(['mousePressed', 'mouseReleased'])
      expect(keyUps(mock)).toHaveLength(1)
      client.close()
    }
  )

  it('lets go of nothing when the command released what it pressed before the revocation', async () => {
    const page = holdPage()
    const client = await connect(endpoint)

    await sendAndReceive(client, { id: 11, method: MOUSE, params: pressed })
    await sendAndReceive(client, { id: 12, method: MOUSE, params: released })
    page.revoke()
    await page.release()

    expect(mouseEvents(mock)).toEqual(['mousePressed', 'mouseReleased'])
    client.close()
  })

  it('refuses a release of something the revoked command never pressed', async () => {
    const page = holdPage()
    const client = await connect(endpoint)
    page.revoke()

    const mouseUp = await sendAndReceive(client, { id: 9, method: MOUSE, params: released })
    const keyUp = await sendAndReceive(client, { id: 10, method: KEY, params: shiftUp })

    expect(mouseUp).toMatchObject({ error: { message: REVOKED } })
    expect(keyUp).toMatchObject({ error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual([])
    await page.release()
    client.close()
  })

  it('drops a press it accepted before the revocation but had not delivered yet', async () => {
    mock.webContents.getType.mockReturnValue('webview')
    let grantFocus = (): void => {}
    guardFocus = () => new Promise((resolve) => (grantFocus = () => resolve(() => {})))
    let revoked = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (revoked) {
          throw new Error(REVOKED)
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const client = await connect(endpoint)

    const reply = sendAndReceive(client, {
      id: 3,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }
    })
    await vi.waitFor(() =>
      expect(getSendCommandMethods(mock)).toContain('Emulation.setFocusEmulationEnabled')
    )
    revoked = true
    grantFocus()

    await expect(reply).resolves.toMatchObject({ id: 3, error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual([])
    finish()
    await held
    client.close()
  })

  it('still refuses a deferred press after the revoked command let go of the page', async () => {
    mock.webContents.getType.mockReturnValue('webview')
    let grantFocus = (): void => {}
    guardFocus = () => new Promise((resolve) => (grantFocus = () => resolve(() => {})))
    const page = holdPage()
    const client = await connect(endpoint)

    const reply = sendAndReceive(client, { id: 13, method: MOUSE, params: pressed })
    await vi.waitFor(() =>
      expect(getSendCommandMethods(mock)).toContain('Emulation.setFocusEmulationEnabled')
    )
    page.revoke()
    await page.release()
    grantFocus()

    await expect(reply).resolves.toMatchObject({ id: 13, error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual([])
    client.close()
  })

  it('lets go of a button whose own release failed to land', async () => {
    const page = holdPage()
    const client = await connect(endpoint)
    const send = mock.webContents.debugger.sendCommand.getMockImplementation()
    mock.webContents.debugger.sendCommand.mockImplementationOnce(async () => ({}))
    mock.webContents.debugger.sendCommand.mockImplementationOnce(async () => {
      throw new Error('target closed')
    })

    await sendAndReceive(client, { id: 14, method: MOUSE, params: pressed })
    const failed = await sendAndReceive(client, { id: 15, method: MOUSE, params: released })
    if (send) {
      mock.webContents.debugger.sendCommand.mockImplementation(send)
    }
    page.revoke()
    await page.release()

    expect(failed.error).toBeDefined()
    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      MOUSE,
      expect.objectContaining({ type: 'mouseReleased', x: -1, y: -1 })
    )
    client.close()
  })

  it('forwards commands again once the host command ends', async () => {
    await runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        throw new Error(REVOKED)
      },
      async () => {}
    )
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 4,
      method: 'Accessibility.getFullAXTree',
      params: {}
    })

    expect(response.error).toBeUndefined()
    expect(getSendCommandMethods(mock)).toContain('Accessibility.getFullAXTree')
    client.close()
  })

  it('never refuses the desktop its own page commands while a revoked host command unwinds', async () => {
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        throw new Error(REVOKED)
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )

    await expect(
      sendGuestCdpCommand(
        { ...mock.webContents, id: PAGE_ID },
        'Emulation.setDeviceMetricsOverride',
        {
          width: 400,
          height: 300,
          deviceScaleFactor: 1,
          mobile: false
        }
      )
    ).resolves.toEqual({})
    finish()
    await held
  })
})
