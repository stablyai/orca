import { describe, expect, it, vi } from 'vitest'
import { verifyHostedIosAdversarialTerminalLinks } from '../../scripts/hosted-ios-adversarial-terminal-links.mjs'

describe('hosted iOS adversarial terminal staging', () => {
  it('reuses the registration-stage corpus without a second terminal send', async () => {
    const stageLinks = vi.fn()
    const verifyLinks = vi.fn(async (args, operations) => ({
      evidence: {
        terminalHandle: await operations.writeLinks({
          terminalHandle: args.terminalHandle
        })
      },
      sessionDocument: { href: 'orca-mobile-web://build/session' }
    }))

    await expect(
      verifyHostedIosAdversarialTerminalLinks(
        {
          stagedTerminalHandle: 'pre-staged-terminal'
        },
        { stageLinks, verifyLinks }
      )
    ).resolves.toMatchObject({
      evidence: { terminalHandle: 'pre-staged-terminal' },
      yOffset: 0
    })

    expect(verifyLinks).toHaveBeenCalledWith(
      expect.objectContaining({ terminalHandle: 'pre-staged-terminal' }),
      expect.any(Object)
    )
    expect(stageLinks).not.toHaveBeenCalled()
  })
})
