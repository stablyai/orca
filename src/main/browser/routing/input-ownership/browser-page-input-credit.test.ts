import { describe, expect, it } from 'vitest'
import { BrowserPageInputCredit } from './browser-page-input-credit'
import type { RpcCallerIdentity } from '../../../runtime/rpc/callers/rpc-caller-identity'

const desktop = { kind: 'paired-device', deviceId: 'desk-1' } as const

function setup() {
  let now = 1_000
  const credit = new BrowserPageInputCredit(() => now)
  // A command that delivers activating input to the page while it runs, as a click does.
  const click = (caller: RpcCallerIdentity, page = 'page-1') =>
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

  it("credits no one for an agent CLI's click over the desktop's pairing", async () => {
    const { credit, click } = setup()
    await click({ ...desktop, agent: true })

    expect(credit.consume('tab-1')).toBeNull()
  })
})
