import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeExtractedAppImagePayload } from './appimage-payload-removal'

const originalNoAsar = process.noAsar

afterEach(() => {
  process.noAsar = originalNoAsar
})

async function makePayloadTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-payload-removal-'))
  await mkdir(join(root, 'resources'), { recursive: true })
  // The real leak: Electron's fs patch reports a *.asar file as a directory.
  await writeFile(join(root, 'resources', 'app.asar'), 'asar-payload')
  await writeFile(join(root, 'AppRun'), '#!/bin/sh\n')
  return root
}

describe('removeExtractedAppImagePayload', () => {
  it('removes a payload tree containing an asar file', async () => {
    const root = await makePayloadTree()
    await removeExtractedAppImagePayload(root)
    expect(existsSync(root)).toBe(false)
  })

  it('disables asar interception for the removal', async () => {
    const root = await makePayloadTree()
    let observed: boolean | undefined
    const originalRealpath = process.noAsar
    Object.defineProperty(process, 'noAsar', {
      configurable: true,
      get: () => observed ?? originalRealpath,
      set: (value: boolean) => {
        observed ??= value
      }
    })
    try {
      await removeExtractedAppImagePayload(root)
    } finally {
      Object.defineProperty(process, 'noAsar', {
        configurable: true,
        writable: true,
        value: originalRealpath
      })
    }
    expect(observed).toBe(true)
  })

  it('restores the previous asar setting after a failure', async () => {
    process.noAsar = false
    await expect(
      removeExtractedAppImagePayload(join(tmpdir(), 'orca-missing', 'nested', '\0invalid'))
    ).rejects.toThrow()
    expect(process.noAsar).toBe(false)
  })

  it('is a no-op for a path that does not exist', async () => {
    await expect(
      removeExtractedAppImagePayload(join(tmpdir(), 'orca-payload-removal-absent'))
    ).resolves.toBeUndefined()
  })
})
