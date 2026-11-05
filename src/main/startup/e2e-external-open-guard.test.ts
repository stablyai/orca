import { expect, it, vi } from 'vitest'

const openExternal = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ shell: { openExternal } }))

const { shell } = await import('electron')
const { guardExternalOpensInE2E } = await import('./e2e-external-open-guard')

it("never opens the tester's browser or mail client in an e2e launch", async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  guardExternalOpensInE2E()
  await shell.openExternal('mailto:a@example.com')
  await shell.openExternal('https://example.com')
  expect(openExternal).not.toHaveBeenCalled()
})
