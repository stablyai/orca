import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { transform } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

it('renders React comment controls and selects guide gutter lines', async () => {
  const directory = dirname(fileURLToPath(import.meta.url))
  const output = join(directory, `.comment-ui-test-${randomUUID()}.mjs`)
  const source = await readFile(join(directory, 'comment-ui.jsx'), 'utf8')
  const compiled = await transform(source, { loader: 'jsx', format: 'esm', jsx: 'automatic' })
  await writeFile(output, compiled.code)
  try {
    const { CommentPanel, inlineFromPath } = await import(pathToFileURL(output).href)
    const html = renderToStaticMarkup(createElement(CommentPanel, {
      root: '/guide/test', fingerprint: 'fingerprint', chapters: ['Core', '<Tests & wiring>']
    }))
    assert.match(html, /<summary>Comment on PR<\/summary>/)
    assert.match(html, /<option value="local">Local agent session<\/option>/)
    assert.match(html, /Chapter 2: &lt;Tests &amp; wiring&gt;/)
    assert.ok(!html.includes('<Tests & wiring>'))

    class Element {
      constructor(attributes) { this.attributes = attributes }
      hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
      getAttribute(name) { return this.attributes[name] ?? null }
    }
    const previous = globalThis.HTMLElement
    globalThis.HTMLElement = Element
    try {
      const plus = new Element({ 'data-utility-button': '' })
      const row = new Element({ 'data-column-number': '7', 'data-line-type': 'change-deletion' })
      const file = new Element({ 'data-guide-file-shell': 'src/a.ts' })
      assert.deepEqual(inlineFromPath([plus, row, file]), { kind: 'inline', path: 'src/a.ts', line: 7, side: 'LEFT' })
      assert.equal(inlineFromPath([row, file]), null)
      assert.equal(inlineFromPath([plus, new Element({ 'data-column-number': '0', 'data-line-type': 'context' }), file]), null)
    } finally {
      globalThis.HTMLElement = previous
    }
  } finally {
    await unlink(output)
  }
})
