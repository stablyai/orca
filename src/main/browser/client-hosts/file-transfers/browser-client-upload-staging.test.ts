import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'

let stagingRoot = ''

beforeEach(async () => {
  // Resolve macOS /var aliases so path assertions use the real root.
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-staging-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

describe('BrowserClientUploadStaging', () => {
  it('sweeps staged bytes an abnormal exit left in the root', async () => {
    const orphan = path.join(stagingRoot, 'abandoned', '0')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'report.pdf'), 'remote-bytes')

    new BrowserClientUploadStaging(stagingRoot)

    expect(existsSync(path.join(stagingRoot, 'abandoned'))).toBe(false)
  })
})
