import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

it('renders owned chapters, diff lines, and inline comment targets safely', async () => {
  const directory = dirname(fileURLToPath(import.meta.url))
  const output = join(directory, `.guide-ui-test-${randomUUID()}.mjs`)
  await build({ entryPoints: [join(directory, 'guide-ui.jsx')], outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external' })
  try {
    const { Guide } = await import(pathToFileURL(output).href)
    const html = renderToStaticMarkup(createElement(Guide, {
      url: 'https://github.com/a/b/pull/2', headSha: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), root: '/guide/test',
      guide: { title: 'Review', intent: 'Explain the change', sections: [{ title: 'Core', overview: 'Changes A', diffs: [{ file: 'src/a.ts', summary: 'Updates the value' }] }], unplacedFiles: [] },
      files: [{ path: 'src/a.ts', lines: [{ kind: 'add', text: '<script>alert(1)</script>', line: 2, newLine: 2, side: 'RIGHT' }] }]
    }))
    assert.match(html, /Core/)
    assert.match(html, /data-guide-file-shell="src\/a\.ts"/)
    assert.match(html, /data-column-number="2"/)
    assert.match(html, /data-utility-button/)
    assert.match(html, /&lt;script&gt;alert\(/)
    assert.match(html, /&lt;\/script&gt;/)
    assert.ok(!html.includes('<script>alert(1)</script>'))
  } finally {
    await unlink(output)
  }
})
