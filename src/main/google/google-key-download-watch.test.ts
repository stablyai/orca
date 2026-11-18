import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findGoogleKeyInFolder, watchFolderForGoogleKey } from './google-key-download-watch'

let folder: string
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'orca-google-key-watch-'))
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

const KEY = '{"installed":{"client_id":"1-a.apps.googleusercontent.com","client_secret":"s"}}'

describe('watching Downloads for the Google key', () => {
  it('takes the key once the browser renames it to its final name, ignoring other files', async () => {
    const stop = new AbortController()
    const found = watchFolderForGoogleKey(folder, stop.signal)
    await writeFile(join(folder, 'report.json'), '{}')
    await writeFile(join(folder, 'client_secret_1-a.json.crdownload'), KEY)
    await rename(
      join(folder, 'client_secret_1-a.json.crdownload'),
      join(folder, 'client_secret_1-a.json')
    )
    await expect(found).resolves.toEqual({ ok: true, text: KEY })
  })

  it('skips a key left over from an earlier setup', async () => {
    const stop = new AbortController()
    const found = watchFolderForGoogleKey(folder, stop.signal)
    // Made aside with an old time, then moved in whole: a rename keeps the time.
    const aside = join(folder, 'aside')
    await writeFile(aside, KEY)
    const lastYear = new Date('2020-01-01T00:00:00Z')
    await utimes(aside, lastYear, lastYear)
    await rename(aside, join(folder, 'client_secret_old.json'))
    setTimeout(() => stop.abort(), 300)
    await expect(found).resolves.toMatchObject({ ok: false })
  })

  it('says so when the folder cannot be watched', async () => {
    const result = await watchFolderForGoogleKey(
      join(folder, 'missing'),
      new AbortController().signal
    )
    expect(result).toMatchObject({
      ok: false,
      unwatchable: true,
      message: expect.stringContaining('Add the file')
    })
  })
})

const keyFor = (id: string, projectId: string) =>
  JSON.stringify({
    installed: {
      client_id: `${id}.apps.googleusercontent.com`,
      client_secret: 's',
      project_id: projectId
    }
  })

describe('finding a key already in Downloads', () => {
  const at = async (name: string, text: string, time: Date) => {
    await writeFile(join(folder, name), text)
    await utimes(join(folder, name), time, time)
  }

  it("takes the newest key for the setup's project, made since the key step, and leaves it there", async () => {
    const step = Date.parse('2026-11-03T10:00:00Z')
    await at(
      'client_secret_old.json',
      keyFor('1-old', 'orca-ivy'),
      new Date('2026-11-01T00:00:00Z')
    )
    await at('client_secret_a.json', keyFor('2-a', 'orca-ivy'), new Date('2026-11-03T10:01:00Z'))
    await at('client_secret_b.json', keyFor('3-b', 'orca-other'), new Date('2026-11-03T10:02:00Z'))
    await at(
      'client_secret_c (1).json',
      keyFor('4-c', 'orca-ivy'),
      new Date('2026-11-03T10:03:00Z')
    )
    await at('client_secret_web.json', '{"web":{}}', new Date('2026-11-03T10:04:00Z'))
    await at('notes.json', keyFor('5-d', 'orca-ivy'), new Date('2026-11-03T10:05:00Z'))
    await expect(
      findGoogleKeyInFolder(folder, { since: step, projectId: 'orca-ivy' })
    ).resolves.toMatchObject({ name: 'client_secret_c (1).json', text: keyFor('4-c', 'orca-ivy') })
    // Without a project, the newest Desktop app key.
    await expect(findGoogleKeyInFolder(folder, { since: step })).resolves.toMatchObject({
      name: 'client_secret_c (1).json'
    })
    await expect(
      findGoogleKeyInFolder(folder, { since: step, projectId: 'orca-none' })
    ).resolves.toBeNull()
  })

  it('finds nothing in a missing folder', async () => {
    await expect(findGoogleKeyInFolder(join(folder, 'gone'), { since: 0 })).resolves.toBeNull()
  })
})
