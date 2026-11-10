import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectAppImageGenerationLeases,
  leaseAppImageGenerationForCurrentProcess,
  type AppImageLeaseProcessReader,
  type ProcessStartTicksRead
} from './appimage-generation-lease'

const created: string[] = []
const NAMESPACE = 'a'.repeat(24)
const GENERATION = 'b'.repeat(24)

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeCache(): Promise<{ cacheRootPath: string; rootPath: string; execPath: string }> {
  const base = await mkdtemp(join(tmpdir(), 'orca-appimage-lease-'))
  created.push(base)
  const cacheRootPath = join(base, 'cache')
  const rootPath = join(cacheRootPath, NAMESPACE, GENERATION)
  await mkdir(rootPath, { recursive: true })
  return { cacheRootPath, rootPath, execPath: join(rootPath, 'orca-ide') }
}

function reader(
  processes: Record<number, ProcessStartTicksRead>,
  bootId: string | undefined = 'boot-1'
): AppImageLeaseProcessReader {
  return {
    readStartTicks: (pid) => processes[pid] ?? { status: 'missing' },
    readBootId: async () => bootId
  }
}

describe('AppImage generation leases', () => {
  it('leases the generation for a daemon on its bundled Node', async () => {
    const { cacheRootPath, rootPath } = await makeCache()
    const lease = await leaseAppImageGenerationForCurrentProcess({
      execPath: join(rootPath, 'resources', 'node-runtime', 'bin', 'node'),
      pid: 11,
      platform: 'linux',
      reader: reader({ 11: { status: 'present', startTicks: '700' } })
    })
    expect(lease).not.toBeNull()
    await expect(
      inspectAppImageGenerationLeases(
        cacheRootPath,
        rootPath,
        reader({ 11: { status: 'present', startTicks: '700' } })
      )
    ).resolves.toEqual({ status: 'live' })
  })

  it('keeps the generation when a holder cannot be verified', async () => {
    const { cacheRootPath, rootPath, execPath } = await makeCache()
    await leaseAppImageGenerationForCurrentProcess({
      execPath,
      pid: 10,
      platform: 'linux',
      reader: reader({ 10: { status: 'present', startTicks: '500' } })
    })

    await expect(
      inspectAppImageGenerationLeases(
        cacheRootPath,
        rootPath,
        reader({ 10: { status: 'unavailable' } })
      )
    ).resolves.toMatchObject({ status: 'unverifiable' })
    await expect(
      inspectAppImageGenerationLeases(cacheRootPath, rootPath, {
        ...reader({ 10: { status: 'present', startTicks: '500' } }),
        readBootId: async () => undefined
      })
    ).resolves.toMatchObject({ status: 'unverifiable' })
  })

  it('keeps a fresh unreadable lease and reclaims an old one', async () => {
    const { cacheRootPath, rootPath } = await makeCache()
    const leasePath = join(cacheRootPath, 'leases', `${NAMESPACE}.${GENERATION}.10.500.json`)
    await mkdir(join(cacheRootPath, 'leases'), { recursive: true })
    await writeFile(leasePath, '{not json')

    await expect(
      inspectAppImageGenerationLeases(cacheRootPath, rootPath, reader({}))
    ).resolves.toMatchObject({ status: 'unverifiable' })

    const old = new Date(Date.now() - 120_000)
    await utimes(leasePath, old, old)
    await expect(
      inspectAppImageGenerationLeases(cacheRootPath, rootPath, reader({}))
    ).resolves.toEqual({ status: 'exited' })
    expect(existsSync(leasePath)).toBe(false)
  })

  it('ignores leases on other generations', async () => {
    const { cacheRootPath, rootPath } = await makeCache()
    const otherExec = join(cacheRootPath, NAMESPACE, 'c'.repeat(24), 'orca-ide')
    const live = reader({ 10: { status: 'present', startTicks: '500' } })
    await leaseAppImageGenerationForCurrentProcess({
      execPath: otherExec,
      pid: 10,
      platform: 'linux',
      reader: live
    })

    await expect(inspectAppImageGenerationLeases(cacheRootPath, rootPath, live)).resolves.toEqual({
      status: 'exited'
    })
  })
})
