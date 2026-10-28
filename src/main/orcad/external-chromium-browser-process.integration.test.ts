import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'

const executablePath = process.env.ORCA_BROWSER_EXECUTABLE

// Allow slow first-run macOS binary verification beyond the default test timeout.
const COLD_BROWSER_START_TIMEOUT_MS = 120_000

describe('ExternalChromiumBrowserProcess integration', () => {
  it.runIf(Boolean(executablePath))(
    'navigates, evaluates, and screenshots with the operator executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orcad-external-browser-'))
      const fixturePath = join(root, 'fixture.html')
      await writeFile(
        fixturePath,
        '<!doctype html><title>External Chromium</title><main>external-ready</main><input>'
      )
      const provider = await resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: executablePath },
        resolveInstalledElectronExecutable: async () => null
      })
      try {
        expect(provider?.kind).toBe('chromium')
        if (!provider) {
          throw new Error('External Chromium provider did not resolve.')
        }
        const commands = provider.factory({
          getAgentBrowserBridge: () => null,
          resolveWorktreeSelector: async (selector) => ({ id: selector }),
          resolveBrowserWorkspace: async (selector) => ({ id: selector }),
          resolveBrowserNetworkExecutionHost: () => {
            throw new Error('No browser network execution host')
          },
          getBrowserHostLeaseRegistry: () => {
            throw new Error('No browser host lease registry')
          },
          getRuntimeBrowserPageRegistry: () => {
            throw new Error('No runtime browser page registry')
          },
          getAuthoritativeWindow: () => {
            throw new Error('No renderer')
          },
          getAvailableAuthoritativeWindow: () => null,
          getOffscreenBrowserBackend: () => null
        })
        await expect(
          commands.browserTabCreate({ page: 'external-page', url: 'about:blank' })
        ).resolves.toEqual({ browserPageId: 'external-page' })
        await expect(
          commands.browserGoto({
            page: 'external-page',
            url: pathToFileURL(fixturePath).href
          })
        ).resolves.toMatchObject({ title: 'External Chromium' })
        await expect(
          commands.browserEval({
            page: 'external-page',
            expression: 'document.querySelector("main")?.textContent'
          })
        ).resolves.toMatchObject({ result: 'external-ready' })
        const page = 'external-page'
        const inputValue = (): Promise<unknown> =>
          commands.browserEval({ page, expression: 'document.querySelector("input").value' })
        for (const text of ['--help', '-x', '--', 'a -- b', '--json --session other']) {
          await commands.browserFill({ page, element: 'input', value: text })
          await expect(inputValue()).resolves.toMatchObject({ result: text })
          await commands.browserFill({ page, element: 'input', value: '' })
          await commands.browserKeyboardInsertText({ page, text })
          await expect(inputValue()).resolves.toMatchObject({ result: text })
          await commands.browserFill({ page, element: 'input', value: '' })
          await commands.browserType({ page, input: text })
          await expect(inputValue()).resolves.toMatchObject({ result: text })
        }
        await expect(
          commands.browserScreenshot({ page: 'external-page', format: 'png' })
        ).resolves.toMatchObject({ data: expect.stringMatching(/\S+/), format: 'png' })
      } finally {
        await provider?.stop()
        await rm(root, { recursive: true, force: true })
      }
    },
    COLD_BROWSER_START_TIMEOUT_MS
  )
})
