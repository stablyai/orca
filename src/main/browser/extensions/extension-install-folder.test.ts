import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readDisabledExtensions,
  readInstalledExtensions,
  writeDisabledExtensions
} from './extension-install-folder'

const ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'

async function install(folder: string, id: string, version: string, dir = version) {
  await mkdir(join(folder, id, dir), { recursive: true })
  await writeFile(join(folder, id, dir, 'manifest.json'), JSON.stringify({ name: id, version }))
}

describe('extension install folder', () => {
  let folder: string
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'orca-extensions-'))
  })
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  it('picks the newest version of each store install and skips other folders', async () => {
    await install(folder, ID, '8.9.0', '8.9.0_0')
    await install(folder, ID, '8.10.1', '8.10.1_0')
    await install(folder, 'not-an-extension-id', '1.0.0')
    const installed = await readInstalledExtensions(folder)
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({ id: ID, path: join(folder, ID, '8.10.1_0') })
  })

  it('reads nothing from a missing folder', async () => {
    expect(await readInstalledExtensions(join(folder, 'missing'))).toEqual([])
    expect(await readDisabledExtensions(join(folder, 'missing'))).toEqual(new Set())
  })

  it('round-trips the turned-off set', async () => {
    await writeDisabledExtensions(folder, new Set([ID]))
    expect(await readDisabledExtensions(folder)).toEqual(new Set([ID]))
  })
})
