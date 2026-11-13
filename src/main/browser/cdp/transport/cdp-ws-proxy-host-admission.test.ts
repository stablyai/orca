import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import { runWithRemoteCliPageAdmission } from '../../routing/input-ownership/remote-cli-page-admission'
import { releaseHeldPageInput } from '../input/guest-direct-key-input'
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
  const pressed = { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }

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
})
