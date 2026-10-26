import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const siteRoot = path.resolve(import.meta.dirname, '..')
const contentRoot = path.join(siteRoot, 'content', 'docs')
const publicRoot = path.join(siteRoot, 'public')

async function read(relativePath) {
  return readFile(path.join(siteRoot, relativePath), 'utf8')
}

async function walkFiles(directory, extension) {
  const entries = await readDirectory(directory)
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, extension)))
    } else if (!extension || entry.name.endsWith(extension)) {
      files.push(absolutePath)
    }
  }
  return files
}

async function readDirectory(directory) {
  return readdir(directory, { withFileTypes: true })
}

function publicPathExists(urlPath) {
  const pathname = urlPath.split('#', 1)[0].split('?', 1)[0]
  return existsSync(path.join(publicRoot, pathname.replace(/^\//, '')))
}

function isMediaPath(urlPath) {
  return /\.(?:gif|jpe?g|png|webp|mp4|svg|ico)$/i.test(urlPath.split(/[?#]/, 1)[0])
}

test('docs content and navigation metadata are discoverable', async () => {
  const pages = await walkFiles(contentRoot, '.mdx')
  assert.ok(pages.length > 0, 'expected docs content pages')

  const navigationFiles = await walkFiles(contentRoot, 'meta.json')
  assert.ok(navigationFiles.length > 0, 'expected navigation metadata')
  for (const file of navigationFiles) {
    const metadata = JSON.parse(await readFile(file, 'utf8'))
    assert.ok(metadata.title, `navigation title missing in ${file}`)
    assert.ok(Array.isArray(metadata.pages), `navigation pages missing in ${file}`)
  }
})

test('every local media URL referenced by docs resolves in public assets', async () => {
  const files = await walkFiles(contentRoot, '.mdx')
  const localUrls = new Set()
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(
      /(?:src|href)=['"](\/docs\/[^'"\s)]+)|\]\((\/docs\/[^)\s]+)\)/g
    )) {
      const url = match[1] ?? match[2]
      if (isMediaPath(url)) {
        localUrls.add(url)
      }
    }
  }

  assert.ok(localUrls.size > 0, 'expected docs to reference at least one local media asset')
  for (const url of localUrls) {
    assert.ok(publicPathExists(url), `${url} is referenced but missing from public/`)
  }
})

test('docs content does not link to routes that only exist on the marketing site', async () => {
  const files = await walkFiles(contentRoot, '.mdx')
  assert.ok(files.length > 0, 'expected docs content pages')
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(/\]\((\/(?!docs(?:\/|[)#]))[^)\s]+)\)/g)) {
      assert.fail(`${path.relative(siteRoot, file)} links to an unhosted local route: ${match[1]}`)
    }
  }
})

test('GIF media helpers use the shared poster and video variants', async () => {
  const media = await import(pathToFileURL(path.join(siteRoot, 'src', 'lib', 'demoMedia.mjs')).href)
  assert.equal(media.posterFor('/docs/orca-design-mode.gif'), '/docs/posters/orca-design-mode.jpg')
  assert.equal(media.videoFor('/docs/orca-design-mode.gif'), '/docs/videos/orca-design-mode.mp4')
  assert.equal(media.posterFor('/docs/tab-split.gif'), '/docs/posters/tab-split.jpg')
  assert.equal(media.videoFor('/docs/tab-split.gif'), '/docs/videos/tab-split.mp4')

  for (const name of ['orca-design-mode', 'tab-split']) {
    assert.ok(existsSync(path.join(publicRoot, 'docs', 'posters', `${name}.jpg`)))
    assert.ok(existsSync(path.join(publicRoot, 'docs', 'videos', `${name}.mp4`)))
  }
})

test('OG image fonts ship with their required third-party notice', async () => {
  for (const filename of ['Geist-Regular.ttf', 'Geist-Bold.ttf', 'Geist-Variable.woff2']) {
    assert.ok(
      existsSync(path.join(siteRoot, 'src', 'assets', 'fonts', filename)),
      `missing font: ${filename}`
    )
  }

  const notice = await read('THIRD_PARTY_NOTICES.md')
  assert.match(notice, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(notice, /Copyright \(c\) 2023 Vercel/)
})
