import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWslHostEnvironment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import { encodePairingOffer } from '../../shared/pairing'
import { getWslHostDeploymentStorePath } from '../../shared/wsl-host-deployment-store'
import type { WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderDirectory } from './wsl-distro-holder-record'
import { releaseUnwantedWslHolders, wslHolderKeepPolicy } from './wsl-orphan-holder-release'

const KEY = Buffer.alloc(32, 7).toString('base64')

let userDataPath: string

function addHost(distro: string, port: number): void {
  addWslHostEnvironment(userDataPath, {
    id: `wsl:${distro.toLowerCase()}`,
    name: `${distro} (WSL)`,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${port}`,
      deviceToken: 'token',
      publicKeyB64: KEY
    }),
    record: { kind: 'wsl', distro, localPort: port, remotePort: 6768 }
  })
}

function recordHolder(distro: string): void {
  mkdirSync(wslDistroHolderDirectory(userDataPath), { recursive: true })
  writeFileSync(
    join(wslDistroHolderDirectory(userDataPath), `${distro.toLowerCase()}.json`),
    JSON.stringify({ version: 1, distro, pid: 7, creationTimeMs: 1, startedAtMs: 1 })
  )
}

function fakeHolder() {
  const release = vi.fn(async (_distro: string) => 'exited' as const)
  const holder = {
    ensureHeld: vi.fn(),
    adoptHolders: vi.fn(),
    release,
    releaseAll: vi.fn(),
    holderState: vi.fn()
  } satisfies WslDistroHolder
  return { holder, release, factory: vi.fn(() => holder) }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-orphan-holders-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('releasing orphaned WSL holders at launch', () => {
  it('touches nothing for a user who never ran a WSL host', async () => {
    const { factory } = fakeHolder()
    await expect(
      releaseUnwantedWslHolders({ userDataPath, isWanted: () => false, holder: factory })
    ).resolves.toEqual([])
    // No holder means no process table read and no wsl.exe.
    expect(factory).not.toHaveBeenCalled()
  })

  it('keeps a live host’s holder and releases only orphans and pending removals', async () => {
    addHost('Ubuntu', 42000)
    addHost('Debian', 42001)
    setWslHostPendingStop(userDataPath, 'wsl:debian', {
      since: 1,
      reason: 'busy',
      verdict: 'live'
    })
    recordHolder('Ubuntu')
    recordHolder('Debian')
    recordHolder('Alpine')
    const { release, factory } = fakeHolder()

    const released = await releaseUnwantedWslHolders({
      userDataPath,
      isWanted: wslHolderKeepPolicy({ userDataPath, keepHostHolders: true }),
      holder: factory
    })

    expect(released.map(({ distro }) => distro).sort()).toEqual(['alpine', 'debian'])
    expect(release).not.toHaveBeenCalledWith('ubuntu')
  })
})

describe('wslHolderKeepPolicy', () => {
  it('keeps every holder when the host records cannot all be read', () => {
    addHost('Ubuntu', 42000)
    writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{not json')
    expect(wslHolderKeepPolicy({ userDataPath, keepHostHolders: true })('Alpine')).toBe(true)
  })

  it('keeps the holder of a host added after the policy was made', () => {
    const isWanted = wslHolderKeepPolicy({ userDataPath, keepHostHolders: true })
    addHost('Ubuntu', 42000)
    expect(isWanted('ubuntu')).toBe(true)
  })

  it('keeps an add in flight, and nothing while hosts are off', () => {
    expect(
      wslHolderKeepPolicy({ userDataPath, keepHostHolders: true, isAdding: () => true })('Alpine')
    ).toBe(true)
    addHost('Ubuntu', 42000)
    expect(wslHolderKeepPolicy({ userDataPath, keepHostHolders: false })('Ubuntu')).toBe(false)
  })
})
