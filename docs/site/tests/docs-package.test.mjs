import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const siteRoot = path.resolve(import.meta.dirname, '..')
const contentRoot = path.join(siteRoot, 'content', 'docs')
const publicRoot = path.join(siteRoot, 'public')

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
