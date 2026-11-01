import { describe, expect, it } from 'vitest'
import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from './browser-guest-input-gesture'
import { BrowserPageInputCredit } from './browser-page-input-credit'
import { LOCAL_CLI_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'

const desktop = { kind: 'paired-device', deviceId: 'desk-1' } as const

function setup() {
  let now = 1_000
  const credit = new BrowserPageInputCredit(() => now)
  // A command that delivers activating input to the page while it runs, as a click does.
  const click = (caller: typeof desktop | typeof LOCAL_CLI_RPC_CALLER, page = 'page-1') =>
    credit.during(page, caller, async () => credit.creditInput('tab-1', page))
  return { credit, click, advance: (ms: number) => (now += ms) }
}

describe('BrowserPageInputCredit', () => {
  it('credits the paired client whose command delivered the input, once', async () => {
    const { credit, click } = setup()
    await click(desktop)

    expect(credit.consume('tab-2')).toBeNull()
    expect(credit.consume('tab-1')).toBe('desk-1')
    expect(credit.consume('tab-1')).toBeNull()
  })

  it('leaves the credit alone for commands that deliver no activating input', async () => {
    const { credit, click } = setup()
    await click(desktop)
    await credit.during('page-1', LOCAL_CLI_RPC_CALLER, async () => undefined)

    expect(credit.consume('tab-1')).toBe('desk-1')
  })

  it('credits no client for an agent click, input outside any command, or after the window', async () => {
    const { credit, click, advance } = setup()
    await click(desktop)
    await click(LOCAL_CLI_RPC_CALLER)
    expect(credit.consume('tab-1')).toBeNull()

    await click(desktop)
    credit.creditInput('tab-1', 'page-1')
    expect(credit.consume('tab-1')).toBeNull()

    await click(desktop)
    advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS + 1)
    expect(credit.consume('tab-1')).toBeNull()
  })
})
