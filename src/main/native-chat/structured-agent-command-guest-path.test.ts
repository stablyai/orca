import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DrivePath from '../ipc/wsl-guest-windows-drive-path'

const guest = vi.hoisted((): { mounts: string[] } => ({ mounts: [] }))
vi.mock('../ipc/wsl-guest-windows-drive-path', async (original) => {
  const actual = await original<typeof DrivePath>()
  return {
    ...actual,
    guestNativePathEnv: (pathEnv: string | null | undefined) =>
      actual.guestNativePathEnv(pathEnv, guest.mounts)
  }
})

import { guestNativePathEnv } from '../ipc/wsl-guest-windows-drive-path'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'

const scratch: string[] = []
afterEach(() => {
  guest.mounts = []
  vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function binDir(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `orca-${name}-`))
  scratch.push(directory)
  for (const binary of ['codex', 'codex-custom']) {
    writeFileSync(join(directory, binary), '#!/bin/sh\nexit 0\n')
    chmodSync(join(directory, binary), 0o755)
  }
  return directory
}

// Drive-mount filtering applies to Linux guests; Windows resolves its own shims.
describe.skipIf(process.platform === 'win32')('launch-time CLI resolution in a WSL guest', () => {
  it('skips a Windows shim on a drive mount for the Linux CLI behind it', () => {
    const windowsDrive = binDir('drive')
    const linuxBin = binDir('linux')
    guest.mounts = [windowsDrive]
    expect(
      resolveStructuredAgentCommand('codex', {}, { pathEnv: `${windowsDrive}:${linuxBin}` })
    ).toBe(join(linuxBin, 'codex'))
  })

  it("filters this process's PATH when the caller gives none", () => {
    const windowsDrive = binDir('drive')
    const linuxBin = binDir('linux')
    guest.mounts = [windowsDrive]
    vi.stubEnv('PATH', `${windowsDrive}:${linuxBin}`)
    expect(resolveStructuredAgentCommand('codex', {})).toBe(join(linuxBin, 'codex'))
  })

  it('filters the PATH a Command setting resolves through', () => {
    const windowsDrive = binDir('drive')
    const linuxBin = binDir('linux')
    guest.mounts = [windowsDrive]
    const settings = {
      agentCmdOverrides: { codex: 'codex-custom' },
      agentDefaultEnv: { codex: { PATH: `${windowsDrive}:${linuxBin}` } }
    }
    expect(resolveStructuredAgentCommand('codex', settings)).toBe(join(linuxBin, 'codex-custom'))
  })

  it('keeps the first PATH match off a guest', () => {
    const first = binDir('first')
    const second = binDir('second')
    expect(resolveStructuredAgentCommand('codex', {}, { pathEnv: `${first}:${second}` })).toBe(
      join(first, 'codex')
    )
  })
})

describe('guestNativePathEnv', () => {
  it('returns the PATH as given with no drive mounts', () => {
    expect(guestNativePathEnv('/mnt/c/bin:/usr/bin')).toBe('/mnt/c/bin:/usr/bin')
    expect(guestNativePathEnv(undefined)).toBeUndefined()
  })
})
