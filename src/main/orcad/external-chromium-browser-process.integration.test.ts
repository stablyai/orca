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
        `<!doctype html><title>External Chromium</title><main>external-ready</main><input>
        <h1>Heading</h1><input id="off" disabled value="kept"><input id="num" type="number">
        <div id="combo" role="combobox" tabindex="0">Pick</div><textarea>one two</textarea>
        <div id="keys" tabindex="0"></div>
        <script>
          keys.addEventListener('keydown', (event) => {
            if (event.key.length === 1) keys.textContent += (event.shiftKey ? '^' : '') + event.key
            event.preventDefault()
          })
        </script>`
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
          getRuntimeId: () => 'fixture-runtime',
          getAgentBrowserBridge: () => null,
          resolveWorkspaceSelector: async (selector) => ({ id: selector }),
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
        const read = (expression: string): Promise<unknown> =>
          commands.browserEval({ page, expression: `JSON.stringify(${expression})` })
        await commands.browserFill({ page, element: 'input', value: 'focused' })
        for (const [element, value] of [
          ['h1', 'stray'],
          ['#off', 'x'],
          ['#num', 'abc']
        ]) {
          await expect(commands.browserFill({ page, element, value })).rejects.toMatchObject({
            code: 'browser_element_not_interactable'
          })
        }
        await expect(
          read('[...document.querySelectorAll("input")].map((input) => input.value)')
        ).resolves.toMatchObject({ result: '["focused","kept",""]' })
        await expect(
          commands.browserSelect({ page, element: '#combo', value: 'Pick' })
        ).rejects.toMatchObject({ code: 'browser_element_not_interactable' })
        await commands.browserFocus({ page, element: '#keys' })
        await commands.browserType({ page, input: 'Hi @1' })
        await expect(read('keys.textContent')).resolves.toMatchObject({ result: '"^Hi ^@1"' })
        await commands.browserSelectAll({ page, element: 'textarea' })
        await expect(
          read(
            '[document.querySelector("textarea").selectionStart, document.querySelector("textarea").selectionEnd]'
          )
        ).resolves.toMatchObject({ result: '[0,7]' })
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
