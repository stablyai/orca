import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeHostDescriptorSchema } from '../../shared/runtime-host-descriptor'
import {
  HOST_INSTALLATION_FILENAME,
  computeHostMachineBinding,
  loadHostDescriptor,
  getRuntimeSourceStamp,
  loadOrCreateHostInstallationId,
  publishHostDescriptor
} from './host-descriptor'

function profile(): string {
  return mkdtempSync(join(tmpdir(), 'orca-host-descriptor-'))
}

function storedId(userDataPath: string): unknown {
  return JSON.parse(readFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), 'utf8'))
    .installationId
}

describe('loadOrCreateHostInstallationId', () => {
  it('creates the id once and returns the same id on every later load', async () => {
    const userDataPath = profile()
    const first = await loadOrCreateHostInstallationId(userDataPath)
    expect(await loadOrCreateHostInstallationId(userDataPath)).toBe(first)
    expect(storedId(userDataPath)).toBe(first)
  })

  it('concurrent creators all return the one id that was stored', async () => {
    const userDataPath = profile()
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => loadOrCreateHostInstallationId(userDataPath))
    )
    expect(new Set(ids).size).toBe(1)
    expect(storedId(userDataPath)).toBe(ids[0])
  })

  it('concurrent repairs of a malformed file never fork the id', async () => {
    const userDataPath = profile()
    writeFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), '{not json')
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => loadOrCreateHostInstallationId(userDataPath))
    )
    expect(new Set(ids).size).toBe(1)
    expect(RuntimeHostDescriptorSchema.shape.installationId.safeParse(ids[0]).success).toBe(true)
    expect(storedId(userDataPath)).toBe(ids[0])
  })
})

describe('loadHostDescriptor', () => {
  it('publishes an id and a binding keyed by that id', async () => {
    const userDataPath = profile()
    const descriptor = await loadHostDescriptor(userDataPath, () => 'machine-a')
    expect(RuntimeHostDescriptorSchema.safeParse(descriptor).success).toBe(true)
    expect(descriptor?.machineBinding).toBe(
      computeHostMachineBinding(descriptor!.installationId, 'machine-a', userDataPath)
    )
    expect(await loadHostDescriptor(userDataPath, () => 'machine-a')).toEqual(descriptor)
  })

  it('changes only the binding when the profile moves to another machine', async () => {
    const userDataPath = profile()
    const here = await loadHostDescriptor(userDataPath, () => 'machine-a')
    const moved = await loadHostDescriptor(userDataPath, () => 'machine-b')
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

  it('omits the binding when no machine id is readable', async () => {
    const descriptor = await loadHostDescriptor(profile(), () => null)
    expect(descriptor).toEqual({ installationId: descriptor?.installationId })
  })

  it('publishes nothing, and writes nothing, when the stored id cannot be read', async () => {
    const userDataPath = profile()
    const blocker = join(userDataPath, 'blocker')
    writeFileSync(blocker, '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A read that fails with anything but ENOENT (here ENOTDIR) must not mint a replacement id.
    expect(await loadHostDescriptor(join(blocker, 'profile'), () => 'machine-a')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('getRuntimeSourceStamp', () => {
  it('names the profile as the source and the runtime id as the incarnation', () => {
    const installationId = '0b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e'
    publishHostDescriptor('runtime-stamp-1', { installationId })
    try {
      expect(
        getRuntimeSourceStamp({ getRuntimeId: () => 'runtime-stamp-1' }, '/profiles/a')
      ).toEqual({
        sourceId: installationId,
        incarnation: 'runtime-stamp-1',
        profilePath: '/profiles/a'
      })
    } finally {
      publishHostDescriptor('runtime-stamp-1', null)
    }
  })

  it('stamps nothing before a descriptor is published or without a runtime', () => {
    expect(getRuntimeSourceStamp({ getRuntimeId: () => 'runtime-unpublished' })).toBeNull()
    expect(getRuntimeSourceStamp(undefined)).toBeNull()
  })
})
