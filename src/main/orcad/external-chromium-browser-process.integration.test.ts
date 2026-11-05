import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import type { RuntimeBrowserCommands } from '../runtime/browser/commands/browser-commands'

const executablePath = process.env.ORCA_BROWSER_EXECUTABLE

// Allow slow first-run macOS binary verification beyond the default test timeout.
const COLD_BROWSER_START_TIMEOUT_MS = 120_000

const EvalReply = z.object({ result: z.unknown() })

const CHAT_FIXTURE = `<!doctype html><title>Chat</title><textarea id="box"></textarea>
<button id="send" onclick="sent.push([location.pathname, box.value])">Send</button>
<script>
  const sent = []
  const go = (path) => history.pushState({}, '', path)
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      go('/chat/after-enter')
    }
  })
</script>`

/** The composer stays mounted across routes, so nothing but the URL can tell them apart. */
async function expectUrlGuardsTheChatFixture(
  commands: RuntimeBrowserCommands,
  page: string
): Promise<void> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    setTimeout(() => response.end(CHAT_FIXTURE), request.url?.startsWith('/slow') ? 2_000 : 0)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fixture server has no port')
    }
    const { port } = address
    const url = (path: string): string => `http://127.0.0.1:${port}${path}`
    const inPage = async (expression: string): Promise<unknown> =>
      EvalReply.parse(await commands.browserEval({ page, expression })).result
    const mismatch = (expectedPath: string, actualPath: string, mayHaveStarted = false) => ({
      code: 'browser_expected_url_mismatch',
      data: {
        expectedUrl: url(expectedPath),
        actualUrl: url(actualPath),
        browserPageId: page,
        mayHaveStarted
      }
    })

    await commands.browserGoto({ page, url: url('/chat/a') })
    await expect(
      commands.browserFill({ page, element: '#box', value: 'draft', expectUrl: url('/chat/a') })
    ).resolves.toMatchObject({ browserPageId: page, checkedUrl: url('/chat/a') })

    await inPage(`box.value = ''; go('/chat/b'); 1`)
    await expect(
      commands.browserFill({ page, element: '#box', value: 'wrong', expectUrl: url('/chat/a') })
    ).rejects.toMatchObject(mismatch('/chat/a', '/chat/b'))
    await expect(
      commands.browserClick({ page, element: '#send', expectUrl: url('/chat/a') })
    ).rejects.toMatchObject(mismatch('/chat/a', '/chat/b'))
    await expect(inPage('JSON.stringify([box.value, sent])')).resolves.toBe('["",[]]')

    // Reaches the process queue behind the eval, which moves the route before finishing.
    const ahead = inPage(
      `new Promise((done) => setTimeout(() => { go('/chat/c'); done(location.pathname) }, 500))`
    )
    const queued = commands.browserFill({
      page,
      element: '#box',
      value: 'wrong',
      expectUrl: url('/chat/b')
    })
    await expect(ahead).resolves.toBe('/chat/c')
    await expect(queued).rejects.toMatchObject(mismatch('/chat/b', '/chat/c'))

    await inPage(`box.focus(); go('/chat/d'); 1`)
    await expect(
      commands.browserType({ page, input: 'one\ntwo', expectUrl: url('/chat/d') })
    ).rejects.toMatchObject(mismatch('/chat/d', '/chat/after-enter', true))
    await expect(inPage('box.value')).resolves.toBe('one')

    // `get url` waits out the load, so the guard reads the document the action would reach.
    await inPage(`setTimeout(() => { location.href = '/slow/x' }, 0); 1`)
    await expect(
      commands.browserClick({ page, element: '#send', expectUrl: url('/chat/after-enter') })
    ).rejects.toMatchObject(mismatch('/chat/after-enter', '/slow/x'))
    await expect(inPage('sent.length')).resolves.toBe(0)

    await commands.browserWait({ page, load: 'load' })
    // Delayed past this eval's own reply, which an open dialog would block.
    await inPage(`setTimeout(() => { window.answer = confirm('Send?') }, 300); 1`)
    await expect(
      commands.browserDialogAccept({ page, expectUrl: url('/chat/a') })
    ).rejects.toMatchObject(mismatch('/chat/a', '/slow/x'))
    await vi.waitFor(
      () =>
        expect(
          commands.browserDialogAccept({ page, expectUrl: url('/slow/x') })
        ).resolves.toMatchObject({ browserPageId: page, checkedUrl: url('/slow/x') }),
      { timeout: 5_000 }
    )
    await expect(inPage('window.answer')).resolves.toBe(true)
  } finally {
    server.close()
  }
}

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
        await expectUrlGuardsTheChatFixture(commands, page)
      } finally {
        await provider?.stop()
        await rm(root, { recursive: true, force: true })
      }
    },
    COLD_BROWSER_START_TIMEOUT_MS
  )
})
