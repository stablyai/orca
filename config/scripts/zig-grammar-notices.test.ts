import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { readBundledWebClientFiles } from '../../src/shared/bundled-web-client-manifest'
import { createStaticWebClientHandler } from '../../src/main/runtime/rpc/static-web-client-handler'

it('retains and serves Zig notices after real Vite projection, including proxy prefixes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-zig-notices-'))
  const viteRoot = dirname(createRequire(import.meta.url).resolve('vite/package.json'))
  const publicDir = resolve('src/renderer/public')
  const project = resolve('config/scripts/project-renderer-web-client.mjs')
  try {
    for (const html of ['index.html', 'web-index.html']) {
      const entry = html === 'index.html' ? 'desktop' : 'entry'
      writeFileSync(
        join(root, html),
        readFileSync(resolve('src/renderer', html), 'utf8').replace(
          /src="\/src\/[^"]+"/,
          `src="./${entry}.js"`
        )
      )
      writeFileSync(join(root, `${entry}.js`), `document.body.textContent = "${entry}"`)
    }
    writeFileSync(
      join(root, 'vite.config.mjs'),
      `export default { base:'./',publicDir:${JSON.stringify(publicDir)},build:{outDir:'out/renderer',manifest:true,rollupOptions:{input:['index.html','web-index.html']}} }`
    )
    for (const args of [[join(viteRoot, 'bin/vite.js'), 'build'], [project]]) {
      const result = await runProcess({
        program: process.execPath,
        args,
        cwd: root,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 30000
      })
      expect(result.code, result.stderr).toBe(0)
    }
    const manifest = readBundledWebClientFiles(join(root, 'out/renderer'))
    for (const output of ['renderer', 'web']) {
      const outputRoot = join(root, 'out', output)
      const html = readFileSync(join(outputRoot, 'web-index.html'), 'utf8')
      const server = createServer(createStaticWebClientHandler(outputRoot))
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Expected notice test HTTP address')
        }
        for (const name of ['LICENSE', 'UPSTREAM']) {
          const asset = `assets/shiki-zig/${name}.txt`
          const original = readFileSync(join(publicDir, asset))
          expect(manifest?.has(asset)).toBe(true)
          expect(readFileSync(join(outputRoot, asset))).toEqual(original)
          expect(html).toContain(`href="./${asset}"`)
          expect(new URL(`./${asset}`, 'https://example.test/orca/web-index.html').pathname).toBe(
            `/orca/${asset}`
          )
          for (const prefix of ['', '/orca']) {
            const response = await fetch(`http://127.0.0.1:${address.port}${prefix}/${asset}`)
            expect(response.status).toBe(200)
            expect(Buffer.from(await response.arrayBuffer())).toEqual(original)
          }
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
