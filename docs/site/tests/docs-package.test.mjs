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

test('docs package has an isolated, reproducible app contract', async () => {
  const packageJson = JSON.parse(await read('package.json'))

  assert.equal(packageJson.name, '@orca/docs')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.packageManager, 'pnpm@10.24.0')
  assert.equal(packageJson.engines.node, '22.x')
  assert.equal(packageJson.scripts.build, 'next build')
  assert.equal(packageJson.scripts.postinstall, 'fumadocs-mdx')
  assert.equal(packageJson.scripts.prebuild, 'fumadocs-mdx')
  for (const dependency of [
    'fumadocs-core',
    'fumadocs-mdx',
    'fumadocs-ui',
    'next',
    'react',
    'react-dom'
  ]) {
    assert.ok(packageJson.dependencies[dependency], `missing runtime dependency: ${dependency}`)
  }
  assert.ok(packageJson.devDependencies.typescript)
  assert.ok(packageJson.devDependencies.vercel)
  assert.ok(existsSync(path.join(siteRoot, 'pnpm-lock.yaml')))
})

test('all customer-facing docs pages and navigation metadata are present', async () => {
  const pages = await walkFiles(contentRoot, '.mdx')
  assert.ok(
    pages.length >= 57,
    `expected at least the current 57 docs pages, found ${pages.length}`
  )

  for (const relativePath of [
    'index.mdx',
    'install.mdx',
    'first-session.mdx',
    'agents/supported.mdx',
    'cli/reference.mdx',
    'remote-servers.mdx',
    'review/github.mdx',
    'settings.mdx',
    'troubleshooting.mdx'
  ]) {
    assert.ok(
      existsSync(path.join(contentRoot, relativePath)),
      `missing docs page: ${relativePath}`
    )
  }

  const navigationFiles = await walkFiles(contentRoot, 'meta.json')
  assert.ok(
    navigationFiles.length >= 8,
    `expected at least the current navigation files, found ${navigationFiles.length}`
  )
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
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(/\]\((\/(?!docs(?:\/|[)#]))[^)\s]+)\)/g)) {
      assert.fail(`${path.relative(siteRoot, file)} links to an unhosted local route: ${match[1]}`)
    }
  }
})

test('published docs do not retain private source provenance', async () => {
  const files = [
    ...(await walkFiles(contentRoot, '.mdx')),
    ...(await walkFiles(contentRoot, 'meta.json')),
    path.join(siteRoot, 'README.md')
  ]
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    assert.doesNotMatch(
      content,
      /orca-(?:internal|marketing-website)|147cdfd|jinwoo@stably\.ai|demo-generation/i,
      path.relative(siteRoot, file)
    )
  }
})

test('reviewed private demo media stays outside the publication boundary', async () => {
  const files = await walkFiles(publicRoot)
  for (const file of files) {
    assert.doesNotMatch(
      path.relative(publicRoot, file),
      /(?:codex-account-switcher|default-agent-opening|any-cli-agent)/i
    )
  }
})

test('docs routes stay namespaced and the generated source uses /docs as its base URL', async () => {
  const source = await read('src/lib/source.ts')
  const sourceConfig = await read('source.config.ts')
  const rootPage = await read('src/app/page.tsx')
  const nextConfig = await read('next.config.ts')
  const searchDialog = await read('src/components/docs/SearchDialog.tsx')
  const appLayout = await read('src/app/layout.tsx')
  const docsLayout = await read('src/app/docs/layout.tsx')
  const ogImage = await read('src/lib/docs-og-image.tsx')
  const header = await read('src/components/layout/DocsHeader.tsx')
  const footer = await read('src/components/layout/DocsFooter.tsx')
  const appFiles = await walkFiles(path.join(siteRoot, 'src', 'app'))

  assert.match(source, /baseUrl:\s*['"]\/docs['"]+/)
  assert.match(
    sourceConfig,
    /dir:\s*['"]content\/docs['"]|dir:\s*docsVersioning\.current\.sourceDir/
  )
  assert.match(sourceConfig, /light:\s*['"]github-light['"]+/)
  assert.match(sourceConfig, /dark:\s*['"]github-dark-high-contrast['"]+/)
  assert.match(rootPage, /redirect\(['"]\/docs['"]\)/)
  assert.match(nextConfig, /assetPrefix:\s*['"]\/docs-static['"]+/)
  assert.match(searchDialog, /api:\s*['"]\/docs\/api\/search['"]+/)
  assert.doesNotMatch(appLayout, /forcedTheme|className=['"][^'"]*\bdark\b/)
  assert.match(docsLayout, /<main\b/)
  assert.match(docsLayout, /themeSwitch=\{\{\s*enabled:\s*false\s*\}\}/)
  assert.match(header, /<ThemeSwitch\b/)
  assert.match(footer, /<h2\b/)
  assert.match(appLayout, /(?:icon|shortcut):\s*['"]\/docs\/favicon\.ico['"]+/)
  assert.match(ogImage, /public\/docs\/logo\.svg/)
  assert.match(header, /src="\/docs\/logo\.svg"/)
  assert.match(footer, /src="\/docs\/logo\.svg"/)
  assert.ok(existsSync(path.join(publicRoot, 'docs', 'logo.svg')))
  assert.ok(existsSync(path.join(publicRoot, 'docs', 'favicon.ico')))
  assert.equal(existsSync(path.join(publicRoot, 'logo.svg')), false)
  assert.equal(existsSync(path.join(publicRoot, 'favicon.ico')), false)
  assert.ok(existsSync(path.join(siteRoot, 'src', 'app', 'docs', 'api', 'search', 'route.ts')))
  assert.equal(existsSync(path.join(siteRoot, 'src', 'app', 'api')), false)
  assert.ok(appFiles.some((file) => file.endsWith(path.join('docs', '[[...slug]]', 'page.tsx'))))
  assert.ok(
    appFiles.every((file) => {
      const relative = path.relative(path.join(siteRoot, 'src', 'app'), file)
      return (
        relative.startsWith(`docs${path.sep}`) ||
        ['globals.css', 'layout.tsx', 'page.tsx'].includes(relative)
      )
    })
  )
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
  assert.equal(existsSync(path.join(publicRoot, 'whats-new')), false)
})

test('versioning seam keeps current docs stable without claiming live versioned routes', async () => {
  const versioning = await read('versioning.config.ts')
  const readme = await read('README.md')

  assert.match(
    versioning,
    /sourceDir:\s*['"]content\/docs['"]|sourceDir:\s*docsVersioning\.current\.sourceDir/
  )
  assert.match(versioning, /urlPrefix:\s*['"]\/docs['"]/)
  assert.match(versioning, /versionsDir:\s*['"]content\/versions['"]+/)
  assert.match(readme, /future snapshots|future versioned|versioned/i)
  assert.doesNotMatch(readme, /packages\/docs/)
})

test('OG image fonts ship with their required third-party notice', async () => {
  for (const filename of ['Geist-Regular.ttf', 'Geist-Bold.ttf', 'Geist-Variable.woff2']) {
    assert.ok(
      existsSync(path.join(siteRoot, 'src', 'assets', 'fonts', filename)),
      `missing font: ${filename}`
    )
  }

  const notice = await read('THIRD_PARTY_NOTICES.md')
  const ogImage = await read('src/lib/docs-og-image.tsx')
  assert.match(notice, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(notice, /Copyright \(c\) 2023 Vercel/)
  assert.doesNotMatch(ogImage, /linear-gradient|boxShadow/)
})

test('docs app has no marketing-only route or analytics dependency', async () => {
  const sourceFiles = await walkFiles(path.join(siteRoot, 'src'))
  for (const file of sourceFiles) {
    const content = await readFile(file, 'utf8')
    assert.doesNotMatch(
      content,
      /(?:from|import)\s+['"`][^'"`]*(?:posthog|plausible|segment)|marketing-website/i,
      file
    )
  }
  assert.equal(existsSync(path.join(siteRoot, 'src', 'app', 'download')), false)
  assert.equal(existsSync(path.join(siteRoot, 'src', 'app', 'pricing')), false)
})
