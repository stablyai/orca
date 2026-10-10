import type * as Fs from 'node:fs'
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeHostDescriptorSchema } from '../../shared/runtime-host-descriptor'
import {
  HOST_INSTALLATION_FILENAME,
  computeHostMachineBinding,
  loadHostDescriptor,
  loadOrCreateHostInstallationId
} from './host-descriptor'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return { ...actual, linkSync: vi.fn(actual.linkSync) }
})

function profile(): string {
  return mkdtempSync(join(tmpdir(), 'orca-host-descriptor-'))
}

afterEach(() => {
  vi.mocked(linkSync).mockClear()
})

describe('loadOrCreateHostInstallationId', () => {
  it('creates the id once and returns the same id on every later load', () => {
    const userDataPath = profile()
    const first = loadOrCreateHostInstallationId(userDataPath)
    expect(loadOrCreateHostInstallationId(userDataPath)).toBe(first)
    expect(
      JSON.parse(readFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), 'utf8'))
    ).toEqual({ installationId: first })
  })

  it('keeps the id a racing creator published first', () => {
    const userDataPath = profile()
    const racer = '0b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e'
    vi.mocked(linkSync).mockImplementationOnce(() => {
      writeFileSync(
        join(userDataPath, HOST_INSTALLATION_FILENAME),
        JSON.stringify({ installationId: racer })
      )
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    })
    expect(loadOrCreateHostInstallationId(userDataPath)).toBe(racer)
  })

  it('falls back to exclusive create where hard links are unsupported', () => {
    const userDataPath = profile()
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('no links'), { code: 'ENOTSUP' })
    })
    const id = loadOrCreateHostInstallationId(userDataPath)
    expect(loadOrCreateHostInstallationId(userDataPath)).toBe(id)
  })

  it('replaces a malformed file', () => {
    const userDataPath = profile()
    writeFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), '{not json')
    const id = loadOrCreateHostInstallationId(userDataPath)
    expect(RuntimeHostDescriptorSchema.shape.installationId.safeParse(id).success).toBe(true)
    expect(loadOrCreateHostInstallationId(userDataPath)).toBe(id)
  })
})

describe('loadHostDescriptor', () => {
  it('publishes an id and a binding keyed by that id', () => {
    const userDataPath = profile()
    const descriptor = loadHostDescriptor(userDataPath, () => 'machine-a')
    expect(RuntimeHostDescriptorSchema.safeParse(descriptor).success).toBe(true)
    expect(descriptor?.machineBinding).toBe(
      computeHostMachineBinding(descriptor!.installationId, 'machine-a', userDataPath)
    )
    expect(loadHostDescriptor(userDataPath, () => 'machine-a')).toEqual(descriptor)
  })

  it('changes only the binding when the profile moves to another machine', () => {
    const userDataPath = profile()
    const here = loadHostDescriptor(userDataPath, () => 'machine-a')
    const moved = loadHostDescriptor(userDataPath, () => 'machine-b')
    expect(moved?.installationId).toBe(here?.installationId)
    expect(moved?.machineBinding).not.toBe(here?.machineBinding)
  })

  it('binds to the profile path, so a copied profile on the same machine differs', () => {
    const id = '0b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e'
    expect(computeHostMachineBinding(id, 'machine-a', '/profiles/one')).not.toBe(
      computeHostMachineBinding(id, 'machine-a', '/profiles/two')
    )
  })

  it('never uses the same binding for two installations on one machine', () => {
    expect(
      computeHostMachineBinding('0b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e', 'machine-a', '/p')
    ).not.toBe(computeHostMachineBinding('1b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e', 'machine-a', '/p'))
  })

  it('omits the binding when no machine id is readable', () => {
    const descriptor = loadHostDescriptor(profile(), () => null)
    expect(descriptor).toEqual({ installationId: descriptor?.installationId })
  })

  it('publishes nothing, and writes nothing, when the stored id cannot be read', () => {
    const userDataPath = profile()
    const blocker = join(userDataPath, 'blocker')
    writeFileSync(blocker, '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A read that fails with anything but ENOENT (here ENOTDIR) must not mint a replacement id.
    expect(loadHostDescriptor(join(blocker, 'profile'), () => 'machine-a')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
