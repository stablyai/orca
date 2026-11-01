import { describe, expect, it } from 'vitest'
import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from './browser-guest-input-gesture'
import { BrowserPageInputCredit } from './browser-page-input-credit'
import { LOCAL_CLI_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'

const desktop = { kind: 'paired-device', deviceId: 'desk-1' } as const

function setup() {
  let now = 1_000
  const credit = new BrowserPageInputCredit(() => now)
  const run = (caller: typeof desktop | typeof LOCAL_CLI_RPC_CALLER, page = 'page-1') =>
    credit.during(page, caller, async () => undefined)
  return { credit, run, advance: (ms: number) => (now += ms) }
}

describe('BrowserPageInputCredit', () => {
  it('credits the paired client whose command ran last on the page, once', async () => {
    const { credit, run } = setup()
    await run(desktop)

    expect(credit.consume('page-2')).toBeNull()
    expect(credit.consume('page-1')).toBe('desk-1')
    expect(credit.consume('page-1')).toBeNull()
  })

  it('keeps the credit while the command runs, however long it queued', async () => {
    const { credit, advance } = setup()
    let consumed: string | null = null

    await credit.during('page-1', desktop, async () => {
      advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS * 5)
      consumed = credit.consume('page-1')
    })

    expect(consumed).toBe('desk-1')
  })

  it('credits no client after an agent command or once the window passes', async () => {
    const { credit, run, advance } = setup()
    await run(desktop)
    await run(LOCAL_CLI_RPC_CALLER)
    expect(credit.consume('page-1')).toBeNull()

    await run(desktop)
    advance(BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS + 1)
    expect(credit.consume('page-1')).toBeNull()
  })
})
