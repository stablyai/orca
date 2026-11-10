// orcad-boot (image/vm/orcad-boot) against a stand-in bundle: it must load the bundle the way a
// plain `node orcad-server.js` would, with or without its code cache, and never run a stale cache.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BOOT = fileURLToPath(new URL('../image/vm/orcad-boot', import.meta.url).href)

// Same length for every marker: V8 accepts a cache for any source of the cached length.
const bundleSource = (marker: string): string => `
const out = {
  marker: ${JSON.stringify(marker)},
  argv: process.argv.slice(1),
  filename: __filename,
  dirname: __dirname,
  viaLoader: Boolean(require.cache[__filename]),
  sibling: require('./sibling.js'),
  exportsIsThis: this === module.exports
}
import('./esm-sibling.mjs').then((esm) => {
  out.esm = esm.value
  console.log(JSON.stringify(out))
})
`

let dir = ''
let bundle = ''
let cache = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcad-boot-'))
  bundle = join(dir, 'orcad-server.js')
  cache = join(dir, 'orcad-server.v8')
  writeFileSync(join(dir, 'sibling.js'), 'module.exports = "cjs-sibling"\n')
  writeFileSync(join(dir, 'esm-sibling.mjs'), 'export const value = "esm-sibling"\n')
  writeFileSync(bundle, bundleSource('A'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function boot(...args: string[]) {
  const result = spawnSync(process.execPath, [BOOT, '--code-cache', cache, ...args, bundle, '--port', '6768'], {
    cwd: tmpdir(),
    encoding: 'utf8'
  })
  return { status: result.status, stderr: result.stderr, out: result.status === 0 ? JSON.parse(result.stdout) : null }
}

describe('orcad-boot', () => {
  it('without a cache, loads the bundle through the CommonJS loader as node would', () => {
    const { status, out, stderr } = boot()
    expect(status).toBe(0)
    expect(stderr).toBe('')
    expect(out).toEqual({
      marker: 'A',
      argv: [bundle, '--port', '6768'],
      filename: realpathSync(bundle),
      dirname: realpathSync(dir),
      viaLoader: true,
      sibling: 'cjs-sibling',
      exportsIsThis: true,
      esm: 'esm-sibling'
    })
  })

  it('writes the cache on exit, then runs the bundle from it with the same globals', () => {
    const first = boot('--write-code-cache')
    expect(first.status).toBe(0)
    expect(first.stderr).toMatch(/^orcad-boot: wrote \d+ bytes of code cache\n$/)
    expect(readFileSync(cache, 'latin1').startsWith(`orcad-code-cache-v1 ${process.version} ${process.arch} `)).toBe(true)

    const second = boot()
    expect(second.status).toBe(0)
    // No experimental-API warning or cache complaint reaches orcad's log.
    expect(second.stderr).toBe('')
    expect(second.out).toEqual({ ...first.out, viaLoader: false })
    expect(first.out).toMatchObject({ marker: 'A', argv: [bundle, '--port', '6768'], esm: 'esm-sibling' })
  })

  it('never runs a cache taken from other bundle bytes, even of the same length', () => {
    expect(boot('--write-code-cache').status).toBe(0)
    writeFileSync(bundle, bundleSource('B'))

    const { status, out, stderr } = boot()
    expect(status).toBe(0)
    expect(stderr).toContain('code cache is for another orcad build')
    expect(out).toMatchObject({ marker: 'B', viaLoader: true })
  })

  it('ignores a truncated cache', () => {
    writeFileSync(cache, 'orcad-code-cache-v1')
    const { status, out } = boot()
    expect(status).toBe(0)
    expect(out).toMatchObject({ marker: 'A', viaLoader: true })
  })

  it('refuses to start without a cache path or bundle', () => {
    const result = spawnSync(process.execPath, [BOOT, bundle], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: orcad-boot')
  })
})
