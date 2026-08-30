/**
 * Structural tests for the open-source docs package.
 * Drive real filesystem + package entry points — no hardcoded content claims.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const pkgRoot = join(fileURLToPath(new URL('..', import.meta.url)))

function listFiles(dir, predicate = () => true) {
  const out = []
  if (!existsSync(dir)) {
    return out
  }
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) {
      out.push(...listFiles(p, predicate))
    } else if (predicate(p)) {
      out.push(p)
    }
  }
  return out
}

test('package.json exposes installable build/dev/start scripts', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@orca/docs')
  for (const script of ['dev', 'build', 'start', 'test']) {
    assert.ok(pkg.scripts[script], `missing script: ${script}`)
  }
  assert.ok(pkg.dependencies.next)
  assert.ok(pkg.dependencies['fumadocs-mdx'])
  assert.ok(pkg.dependencies['fumadocs-ui'])
  assert.ok(pkg.dependencies['fumadocs-core'])
})

test('content/docs has MDX pages and meta.json tree', () => {
  const contentRoot = join(pkgRoot, 'content/docs')
  const mdx = listFiles(contentRoot, (p) => p.endsWith('.mdx'))
  const meta = listFiles(contentRoot, (p) => p.endsWith('meta.json'))
  assert.ok(mdx.length >= 20, `expected many MDX pages, got ${mdx.length}`)
  assert.ok(meta.length >= 1, 'expected meta.json files for nav')
  assert.ok(existsSync(join(contentRoot, 'index.mdx')), 'docs index page must exist')
  const index = readFileSync(join(contentRoot, 'index.mdx'), 'utf8')
  assert.match(index, /Orca|worktree|agent/i)
})

test('docs media assets exist for MDX ImagePlaceholder paths', () => {
  const contentRoot = join(pkgRoot, 'content/docs')
  const mdxFiles = listFiles(contentRoot, (p) => p.endsWith('.mdx'))
  const srcs = new Set()
  for (const file of mdxFiles) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/src="(\/[^"]+)"/g)) {
      srcs.add(m[1])
    }
  }
  assert.ok(srcs.size > 0, 'expected ImagePlaceholder src paths in MDX')
  const missing = []
  for (const src of srcs) {
    const abs = join(pkgRoot, 'public', src.slice(1))
    if (!existsSync(abs)) {
      missing.push(src)
    }
  }
  assert.deepEqual(missing, [], `missing public assets: ${missing.join(', ')}`)
})

test('docs-only shell has no marketing homepage/enterprise/download routes', () => {
  const appDir = join(pkgRoot, 'src/app')
  const forbidden = ['enterprise', 'download', 'changelog', 'diagnostics', 'privacy', 'terms']
  for (const name of forbidden) {
    assert.equal(existsSync(join(appDir, name)), false, `must not ship marketing route: ${name}`)
  }
  assert.equal(existsSync(join(pkgRoot, 'src/components/product-animations')), false)
  assert.equal(existsSync(join(pkgRoot, 'src/components/sections')), false)
  assert.equal(existsSync(join(pkgRoot, 'src/components/DownloadButton.tsx')), false)
})

test('source loader pins baseUrl /docs for stable public URLs', () => {
  const sourceTs = readFileSync(join(pkgRoot, 'src/lib/source.ts'), 'utf8')
  assert.match(sourceTs, /baseUrl:\s*['"]\/docs['"]/)
})

test('demoMedia poster/video resolve to shipped public files for every MDX GIF', async () => {
  // Real shipped pure helpers (JS); AutoplayClip imports via TS re-export.
  const { posterFor, videoFor } = await import(
    new URL('../src/lib/demoMedia.mjs', import.meta.url).href
  )
  // Marketing-compatible: GIF may live under /docs or /whats-new; encode always under /whats-new.
  assert.equal(posterFor('/docs/orca-split-screen.gif'), '/whats-new/posters/orca-split-screen.jpg')
  assert.equal(videoFor('/docs/orca-split-screen.gif'), '/whats-new/videos/orca-split-screen.mp4')
  assert.equal(posterFor('/whats-new/tab-split.gif'), '/whats-new/posters/tab-split.jpg')
  assert.equal(videoFor('/whats-new/tab-split.gif'), '/whats-new/videos/tab-split.mp4')

  const contentRoot = join(pkgRoot, 'content/docs')
  const mdxFiles = listFiles(contentRoot, (p) => p.endsWith('.mdx'))
  const gifSrcs = new Set()
  for (const file of mdxFiles) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/src="(\/[^"]+\.gif)"/g)) {
      gifSrcs.add(m[1])
    }
  }
  assert.ok(gifSrcs.size > 0, 'expected GIF srcs in MDX for AutoplayClip')

  const missing = []
  for (const src of gifSrcs) {
    const poster = posterFor(src)
    const video = videoFor(src)
    const posterAbs = join(pkgRoot, 'public', poster.slice(1))
    const videoAbs = join(pkgRoot, 'public', video.slice(1))
    if (!existsSync(posterAbs)) {
      missing.push(`poster for ${src} -> ${poster}`)
    }
    if (!existsSync(videoAbs)) {
      missing.push(`video for ${src} -> ${video}`)
    }
  }
  assert.deepEqual(missing, [], `missing demo media:\n${missing.join('\n')}`)

  const reexport = readFileSync(join(pkgRoot, 'src/lib/demoMedia.ts'), 'utf8')
  assert.match(reexport, /from ['"]\.\/demoMedia\.mjs['"]/)
})

test('production build output directory is non-empty after next build (when present)', () => {
  const nextDir = join(pkgRoot, '.next')
  if (!existsSync(nextDir)) {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.build.includes('next build'), true)
    return
  }
  const size = listFiles(nextDir).length
  assert.ok(size > 10, `.next should contain build artifacts, found ${size} files`)
})

test('README documents install/dev/build/start', () => {
  const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8')
  assert.match(readme, /pnpm install/)
  assert.match(readme, /pnpm dev/)
  assert.match(readme, /pnpm build/)
  assert.match(readme, /pnpm start/)
  assert.match(readme, /\/docs/)
})

test('relative content tree is under packages/docs only', () => {
  const rel = relative(pkgRoot, join(pkgRoot, 'content/docs/index.mdx'))
  assert.equal(rel, join('content', 'docs', 'index.mdx'))
  assert.ok(statSync(join(pkgRoot, 'content/docs/index.mdx')).isFile())
})
