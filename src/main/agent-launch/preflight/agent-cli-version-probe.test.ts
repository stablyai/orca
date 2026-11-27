import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkAgentCliVersion } from './agent-cli-version-probe'

// Root and Windows ignore POSIX mode bits.
const modeBitsEnforced = process.platform !== 'win32' && process.getuid?.() !== 0

describe.runIf(modeBitsEnforced)('checkAgentCliVersion in a denied folder', () => {
  let root: string

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    root = await mkdtemp(join(tmpdir(), 'orca-cli-version-'))
    await mkdir(join(root, 'locked'), 0o000)
    await mkdir(join(root, 'unlistable'), 0o311)
    await writeFile(join(root, 'not-executable'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o644 })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(['locked', 'unlistable'].map((name) => chmod(join(root, name), 0o755)))
    await rm(root, { recursive: true, force: true })
  })

  it('blames the folder only when the probe cannot enter it', async () => {
    const program = process.execPath
    expect(await checkAgentCliVersion({ program, cwd: join(root, 'locked') }, [])).toEqual({
      status: 'cwdAccessDenied',
      version: null
    })
    // Entering needs search permission alone, so here the non-executable agent is at fault.
    const unlistable = join(root, 'unlistable')
    expect(
      await checkAgentCliVersion({ program: join(root, 'not-executable'), cwd: unlistable }, [])
    ).toEqual({
      status: 'missing',
      version: null
    })
  })
})
