import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main as verifyTogether } from './verify-localization-catalogs.mjs'

const directories = []
const renderer = 'src/renderer/src'
const englishPath = `${renderer}/i18n/locales/en.json`
const runtimePath = `${renderer}/i18n/en-runtime-required.json`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-localization-checks-'))
  directories.push(root)
  await mkdir(join(root, renderer, 'i18n/locales'), { recursive: true })
  await mkdir(join(root, 'src/main'), { recursive: true })
  await writeFile(join(root, renderer, 'greeting.ts'), "translate('hello', 'Hello')\n")
  await writeFile(join(root, 'src/main/ready.ts'), "translateMain('ready', 'Ready')\n")
  await writeFile(
    join(root, englishPath),
    JSON.stringify({ hello: 'Hello', ready: 'Ready', dynamic: 'Required' })
  )
  await writeFile(join(root, runtimePath), JSON.stringify({ dynamic: 'Required' }))
  await mkdir(join(root, 'src/shared/plugins/languages'), { recursive: true })
  await writeFile(
    join(root, 'src/shared/plugins/languages/protected-copy-keys.json'),
    `${JSON.stringify({ keys: [], prefixes: [] }, null, 2)}\n`
  )
  return root
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('combined localization verification', () => {
  it('reads source edits, new files, removals, and separate roots on each invocation', async () => {
    const root = await fixture()
    expect(await verifyTogether(root)).toBe(0)
    await writeFile(join(root, renderer, 'greeting.ts'), "translate('hello', 'New fallback')")
    expect(await verifyTogether(root)).toBe(1)
    await writeFile(join(root, renderer, 'greeting.ts'), "translate('hello', 'Hello')")
    expect(await verifyTogether(root)).toBe(0)
    await writeFile(join(root, 'src/main/added.ts'), "translateMain('absent', 'Absent')")
    expect(await verifyTogether(root)).toBe(1)
    await rm(join(root, 'src/main/added.ts'))
    expect(await verifyTogether(root)).toBe(0)
    expect(await verifyTogether(await fixture())).toBe(0)
  })
})
