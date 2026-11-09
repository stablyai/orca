import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'
import { shortDaemonSocketDir } from '../../../daemon/endpoint/publication/daemon-socket-endpoint-path'
import { createRuntimeTransportMetadata } from './runtime-rpc-socket-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

import type { RuntimeMetadata } from '../../../../shared/runtime-bootstrap'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('OrcaRuntimeRpcServer', () => {
  it('reclaims runtime metadata clobbered by a second instance that has since died', async () => {
    // A second instance can replace metadata then exit; reclaim it so CLI finds this still-serving runtime (#7848).
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })
    await server.start()
    const published = readRuntimeMetadata(userDataPath)

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [{ kind: 'unix', endpoint: join(userDataPath, 'o-99999999-rt2.sock') }],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    await server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toEqual(published)

    await server.stop()
  })

  it('leaves runtime metadata owned by a live sibling runtime untouched', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Use a synthetic owned pid and process.pid as live sibling; Windows never assigns pid 1.
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      pid: 4242
    })
    await server.start()

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_live_sibling',
      pid: process.pid,
      transports: [{ kind: 'unix', endpoint: join(userDataPath, `o-${process.pid}-rt2.sock`) }],
      authToken: 'sibling-token',
      startedAt: 1
    })
    await server.checkRuntimeMetadataOwnership()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_live_sibling' })

    await server.stop()
  })

  it('drops a republish from an ownership read that lands after the server stopped', async () => {
    // In-flight async reads can outlive stop; activeTransports must prevent late republish.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath, pid: 1001 })
    await server.start()

    let releaseRead: (record: RuntimeMetadata | null) => void = () => {}
    vi.spyOn(runtimeMetadataModule, 'readRuntimeMetadataAsync').mockImplementationOnce(
      () =>
        new Promise<RuntimeMetadata | null>((resolve) => {
          releaseRead = resolve
        })
    )
    const heldCheck = server.checkRuntimeMetadataOwnership()

    await server.stop()
    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_second_instance',
      pid: 99999999,
      transports: [],
      authToken: 'second-instance-token',
      startedAt: 1
    })
    // A missing record is the most reclaimable verdict there is, so an unguarded
    // resume would rewrite the file the second instance just published.
    releaseRead(null)
    await heldCheck

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ runtimeId: 'rt_second_instance' })
  })

  it('closes the socket if metadata publication fails during startup', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ methods: [], runtime, userDataPath })
    const writeMetadataSpy = vi
      .spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
      .mockImplementationOnce(() => {
        throw new Error('write failed')
      })
    const endpoint = createRuntimeTransportMetadata(
      userDataPath,
      process.pid,
      process.platform,
      runtime.getRuntimeId()
    ).endpoint

    await expect(server.start()).rejects.toThrow('write failed')
    expect(readRuntimeMetadata(userDataPath)).toBeNull()
    expect(existsSync(endpoint)).toBe(false)
    expect(server['transports']).toEqual([])
    expect(server['activeTransports']).toEqual([])

    writeMetadataSpy.mockRestore()
  })

  it.skipIf(process.platform === 'win32')(
    'never sweeps inside a relocated socket dir that is not private to this user',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const relocatedDir = shortDaemonSocketDir(userDataPath, process.getuid!())
      mkdirSync(dirname(relocatedDir), { recursive: true, mode: 0o700 })
      mkdirSync(relocatedDir, { recursive: true, mode: 0o755 })
      const deadSocket = join(relocatedDir, 'o-99999999-dead.sock')
      writeFileSync(deadSocket, '')
      const server = new OrcaRuntimeRpcServer({
        methods: [],
        runtime: new OrcaRuntimeService(),
        userDataPath
      })
      try {
        await server.start()
        expect(existsSync(deadSocket)).toBe(true)
      } finally {
        await server.stop()
        rmSync(relocatedDir, { recursive: true, force: true })
      }
    }
  )
})
