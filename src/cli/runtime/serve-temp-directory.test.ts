import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyServeTempDirectory,
  prepareServeTempDirectory,
  SERVE_TEMP_DIRECTORY_ENV
} from './serve-temp-directory'

describe('serve temporary directory', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('validates an absolute configured directory and applies it to the Electron child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-serve-temp-'))
    roots.push(root)

    const directory = prepareServeTempDirectory({
      env: { [SERVE_TEMP_DIRECTORY_ENV]: root }
    })
    const childEnv = applyServeTempDirectory({}, directory, 'linux')

    expect(directory).toBe(root)
    expect(childEnv).toMatchObject({
      [SERVE_TEMP_DIRECTORY_ENV]: root,
      TMPDIR: root
    })
  })

  it('reports ENOSPC with configuration guidance before Electron starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-serve-temp-full-'))
    roots.push(root)
    const error = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })

    let caught: unknown
    try {
      prepareServeTempDirectory({
        env: { [SERVE_TEMP_DIRECTORY_ENV]: root },
        writeProbeFile: () => {
          throw error
        }
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'serve_temp_unavailable',
      causeCode: 'ENOSPC',
      message: expect.stringContaining(SERVE_TEMP_DIRECTORY_ENV)
    })
  })

  it('rejects a relative configured directory', async () => {
    let caught: unknown
    try {
      prepareServeTempDirectory({
        env: { [SERVE_TEMP_DIRECTORY_ENV]: 'relative/tmp' }
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'serve_temp_unavailable',
      message: expect.stringContaining('absolute')
    })
  })
})
