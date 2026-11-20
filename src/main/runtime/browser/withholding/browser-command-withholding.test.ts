import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_WITHHELD_RESULT } from '../../../../shared/browser/runtime/browser-withheld-result'
import {
  BROWSER_WITHHELD_FAILURE,
  BROWSER_WITHHELD_REFUSAL,
  runWithheldBrowserCommand,
  setBrowserWorkspaceWithheld
} from './browser-command-withholding'

const AGENT = { kind: 'local-cli' } as const
const SECRET = 'GOCSPX-never-shown'

function command(method: string, workspaceId: string | null, caller = AGENT) {
  return { method, caller, workspaceOf: async () => workspaceId }
}

describe("an agent's browser command while its workspace's page may show a secret", () => {
  afterEach(() => setBrowserWorkspaceWithheld(null))

  it('runs actions but answers with a fixed acknowledgement, failures included', async () => {
    setBrowserWorkspaceWithheld((id) => id === 'folder:ivy' || id === null)
    const click = vi.fn(async () => ({ effects: { page: [SECRET] } }))
    await expect(
      runWithheldBrowserCommand(command('browser.click', 'folder:ivy'), click)
    ).resolves.toEqual(BROWSER_WITHHELD_RESULT)
    expect(click).toHaveBeenCalledOnce()
    await expect(
      runWithheldBrowserCommand(command('browser.find', null), async () => {
        throw new Error(`element not found near ${SECRET}`)
      })
    ).rejects.toThrow(BROWSER_WITHHELD_FAILURE)
  })

  it('never runs a read, a capture or raw exec', async () => {
    setBrowserWorkspaceWithheld((id) => id === 'folder:ivy')
    for (const method of [
      'browser.snapshot',
      'browser.eval',
      'browser.screenshot',
      'browser.exec'
    ]) {
      const read = vi.fn(async () => SECRET)
      await expect(runWithheldBrowserCommand(command(method, 'folder:ivy'), read)).rejects.toThrow(
        BROWSER_WITHHELD_REFUSAL
      )
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('leaves other workspaces, tab commands and people alone', async () => {
    setBrowserWorkspaceWithheld((id) => id === 'folder:ivy')
    const read = async () => SECRET
    await expect(
      runWithheldBrowserCommand(command('browser.snapshot', 'folder:rex'), read)
    ).resolves.toBe(SECRET)
    await expect(
      runWithheldBrowserCommand(command('browser.tabList', 'folder:ivy'), read)
    ).resolves.toBe(SECRET)
    await expect(
      runWithheldBrowserCommand(
        {
          method: 'browser.snapshot',
          caller: { kind: 'desktop' },
          workspaceOf: async () => 'folder:ivy'
        },
        read
      )
    ).resolves.toBe(SECRET)
  })
})
