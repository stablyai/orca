import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { repoRoot } from '../../component-fixtures/fixture-paths.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function servedSources(url, files, phase) {
  const lines = []
  for (const file of files) {
    const disk = await readFile(path.join(repoRoot, 'src/renderer', file))
    const response = await fetch(new URL(file, url), { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) {
      throw new Error(`Fixture server could not serve ${file}: ${response.status}`)
    }
    const served = Buffer.from(await response.arrayBuffer())
    const line = `${file}: disk sha256 ${sha256(disk)}, served sha256 ${sha256(served)} (${served.length} bytes)`
    lines.push(line)
    console.log(`[served ${phase}] ${line}`)
  }
  return lines
}

export function paint(page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

export async function renderFixture(page, url, name, theme, viewport) {
  await page.setViewportSize(viewport)
  const params = new URLSearchParams({ id: `app-rail/AppRail:${name}`, theme })
  await page.goto(`${url}/fixtures.html?${params}`, { waitUntil: 'commit' })
  await page.waitForFunction(
    () => document.documentElement.dataset.fixtureState === 'ready',
    null,
    { timeout: 120_000 }
  )
  await paint(page)
}
