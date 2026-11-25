import { describe, expect, it } from 'vitest'
import { BrowserPageInputCredit } from './browser-page-input-credit'

const viewer = { kind: 'paired-device', deviceId: 'desk-a' } as const
const agent = { kind: 'local-cli' } as const

describe('BrowserPageInputCredit print attribution', () => {
  it('credits a print only to a viewer input no agent command has followed', async () => {
    let now = 1_000
    const credit = new BrowserPageInputCredit(() => now)

    await credit.during('tab', viewer, async () => credit.creditInput('tab', 'tab'))
    // The click also opened a tab; the print it makes is still the viewer's.
    expect(credit.consume('tab')).toBe('desk-a')
    expect(credit.printer('tab')).toBe('desk-a')

    // An agent command taking the tab withdraws it.
    credit.withdraw('tab')
    expect(credit.printer('tab')).toBeNull()

    // An agent's own input credits no one.
    await credit.during('tab', agent, async () => credit.creditInput('tab', 'tab'))
    expect(credit.printer('tab')).toBeNull()

    // A viewer's input while an agent command runs in the tab can't authorize a print.
    await credit.during('tab', viewer, async () =>
      credit.creditInput('tab', 'tab', { printable: false })
    )
    expect(credit.printer('tab')).toBeNull()
    expect(credit.consume('tab')).toBe('desk-a')

    // A viewer's credit lapses with the input gesture.
    await credit.during('tab', viewer, async () => credit.creditInput('tab', 'tab'))
    now += 5_000
    expect(credit.printer('tab')).toBeNull()
  })
})
