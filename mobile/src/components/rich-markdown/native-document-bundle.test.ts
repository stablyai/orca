// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { richMarkdownEditorBundle } from '../../../scripts/build-rich-markdown-editor-script.mjs'
import { RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT } from '../rich-markdown-editor-document-script.generated'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { escapeInjectedJavaScriptString } from '../mobile-rich-markdown-editor-script-string'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  bundleDigestBuiltFrom,
  machinePathCommentsIn
} from '../../test-support/webview-document-bundle-digest'

/**
 * The bundle runs, and it is the same document.
 *
 * The script the WebView loads is no longer a string a concatenator wrote, so it cannot be
 * compared line by line with a golden — and esbuild renames what collides, which would make every
 * text assertion against it a match on a rename. What replaces the byte pin is this: the bundle is
 * executed exactly as the WebView executes it, with the same globals its HTML declares, and then
 * driven through the injected handle the native component reaches it by.
 *
 * That covers the whole path no text assertion ever touched — the entry, the start sequence, the
 * surface read, the listeners and the global install — and it is the one thing that says the
 * bundle is a working document rather than a well-formed string. The module tests beside it say
 * each part does its job.
 */
const evaluated: (() => void)[] = []

type Recorded = { command: string; value: string | undefined }

/**
 * The WebView's own act: the globals its page carries, then the script.
 *
 * `execCommand`, `prompt` and `visualViewport` are the WebView's and happy-dom implements none of
 * them, so a case that wants the document's answer has to supply the browser's half. Recording
 * rather than applying: what the document decides is which verb and value go to the engine.
 */
function evaluateBundle(options: { prompt?: string | null } = {}) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const posted: MobileRichMarkdownEditorMessage[] = []
  const commands: Recorded[] = []
  const viewportListeners: string[] = []
  const viewport = {
    height: 500,
    offsetTop: 20,
    addEventListener: (name: string) => viewportListeners.push(name),
    removeEventListener: () => {}
  }
  Object.assign(globalThis, {
    ReactNativeWebView: {
      postMessage: (message: string) => posted.push(JSON.parse(message))
    },
    prompt: () => options.prompt ?? null,
    visualViewport: viewport,
    innerHeight: 800
  })
  document.execCommand = (command: string, _showUI?: boolean, value?: string) => {
    commands.push({ command, value })
    return true
  }

  new Function(RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT)()
  const handle = window.__orcaRichMarkdown!
  evaluated.push(() => {
    Reflect.deleteProperty(globalThis, '__orcaRichMarkdown')
  })
  return { posted, commands, viewportListeners, handle }
}

/** The native component's transport: a script evaluated in the document's own page. */
function inject(script: string) {
  new Function(`${script}\ntrue;`)()
}

afterEach(() => {
  while (evaluated.length > 0) {
    evaluated.pop()!()
  }
  document.body.innerHTML = ''
})

describe('the bundled rich Markdown editor document', () => {
  it('starts, measures the keyboard, and reports itself ready in that order', () => {
    const { posted, viewportListeners, handle } = evaluateBundle()
    expect(posted).toEqual([{ type: 'keyboardInset', bottom: 280 }, { type: 'ready' }])
    expect(viewportListeners).toEqual(['resize', 'scroll'])
    // The five members the native component reaches through `injectJavaScript`.
    expect(Object.keys(handle).sort()).toEqual([
      'currentMarkdown',
      'dismissKeyboard',
      'runCommand',
      'setEditable',
      'setMarkdown'
    ])
  })

  it('takes markdown through the injected handle and gives back the source it was given', () => {
    const { handle } = evaluateBundle()
    const markdown = [
      '# Title',
      '',
      'A paragraph with **bold**, *italic* and `code`.',
      '',
      '- Parent',
      '  1. Ordered child',
      '    - [x] Done task',
      '    - [ ] Open task',
      '- Sibling',
      '',
      '> Quoted',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---'
    ].join('\n')
    // Through the transport the native component uses, escaping included.
    inject(`window.__orcaRichMarkdown.setMarkdown(${escapeInjectedJavaScriptString(markdown)}, 7);`)
    expect(handle.currentMarkdown()).toBe(markdown)
  })

  it('reports an edit under the generation the host set, and stops when told it is read-only', () => {
    const { posted, handle } = evaluateBundle()
    handle.setMarkdown('first', 4)
    posted.length = 0
    document.getElementById('editor')!.dispatchEvent(new Event('input'))
    expect(posted).toEqual([{ type: 'change', markdown: 'first', generation: 4 }])

    posted.length = 0
    handle.setEditable(false)
    document.getElementById('editor')!.dispatchEvent(new Event('input'))
    expect(posted).toEqual([])
    expect(document.getElementById('editor')!.getAttribute('contenteditable')).toBe('false')
  })

  it('sends every toolbar command to the engine, and asks for the URL the two need', async () => {
    const { commands, handle } = evaluateBundle({ prompt: 'https://example.com/a' })
    handle.setMarkdown('body', 1)
    for (const command of [
      'paragraph',
      'heading1',
      'heading2',
      'heading3',
      'bold',
      'italic',
      'strike',
      'bulletList',
      'orderedList',
      'taskList',
      'quote',
      'codeBlock',
      'link',
      'image'
    ] as const) {
      await handle.runCommand(command)
    }
    expect(commands.map((entry) => entry.command)).toEqual([
      'formatBlock',
      'formatBlock',
      'formatBlock',
      'formatBlock',
      'bold',
      'italic',
      'strikeThrough',
      'insertUnorderedList',
      'insertOrderedList',
      'insertHTML',
      'formatBlock',
      'insertHTML',
      'createLink',
      'insertImage'
    ])
    expect(commands.slice(-2).map((entry) => entry.value)).toEqual([
      'https://example.com/a',
      'https://example.com/a'
    ])
    // The fifteenth needs a selection to wrap and reaches no engine verb at all.
    expect(commands.map((entry) => entry.command)).not.toContain('inlineCode')
  })

  it('refuses a javascript: URL from the dialog, which is the one scheme the document filters', async () => {
    const { commands, handle } = evaluateBundle({ prompt: 'javascript:alert(1)' })
    await handle.runCommand('link')
    expect(commands).toEqual([])
  })

  it('opens a tapped link through the host rather than navigating', () => {
    const { posted, handle } = evaluateBundle()
    handle.setMarkdown('[docs](https://example.com/docs)', 1)
    posted.length = 0
    document.querySelector('#editor a')!.dispatchEvent(new Event('click', { bubbles: true }))
    expect(posted).toContainEqual({ type: 'openLink', url: 'https://example.com/docs' })
  })

  it('is the same bytes wherever its generator was run from', () => {
    // The artifact is committed by a postinstall run whose working directory is whatever the
    // installer happened to be in, and every case above compares it with a build made here. So the
    // build has to be cwd-independent, which is what `absWorkingDir` buys: without it this digest
    // and the one from the temp directory differ, and the artifact carries a machine path.
    // `import.meta.dirname`, because a case in the DOM environment has no file URL to convert.
    const generator = join(
      import.meta.dirname,
      '../../../scripts/build-rich-markdown-editor-script.mjs'
    )
    const here = createHash('sha256').update(RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT).digest('hex')
    expect(bundleDigestBuiltFrom(tmpdir(), generator, 'richMarkdownEditorBundle')).toBe(here)
    expect(machinePathCommentsIn(RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT)).toEqual([])
  }, 30_000)

  it('carries the document and nothing else: no dependency rides into the WebView', async () => {
    // The document imports ordinary modules now, so an import added anywhere in its graph reaches
    // the phone's script. One build, read four ways; the last assertion is what makes the other
    // three about the artifact that ships rather than about a bundle this case built for itself.
    const { script, inputs } = await richMarkdownEditorBundle()
    expect(inputs.filter((input) => input.includes('node_modules'))).toEqual([])
    expect(inputs).toHaveLength(22)
    expect(script).not.toContain('__commonJS')
    // `__esm` wrappers are esbuild's answer to a cycle, and a cycle would make a module's top level
    // run at first import rather than where the bundle places it.
    expect(script).not.toContain('__esm(')
    expect(RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT).toBe(script)
  }, 30_000)
})
