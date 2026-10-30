import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupDaemonForProtocol } from '../daemon/daemon-protocol-cleanup'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import {
  __setDaemonProcessTableReaderForTests,
  killProfileDaemons,
  recordProfileDaemons
} from './orcad-daemon-teardown-fixture'

vi.mock('../daemon/daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))

// Windows preserves dead-parent PPIDs and reuses PIDs; older children can falsely claim the daemon.
describe('daemon descendant walk under Windows pid reuse', () => {
  afterEach(() => {
    __setDaemonProcessTableReaderForTests()
    vi.useRealTimers()
  })

  async function exitedPid(): Promise<number> {
    const child = spawnProcess({ program: process.execPath, args: ['-e', ''], timeoutMs: null })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    if (!child.pid) {
      throw new Error('Child did not start')
    }
    return child.pid
  }

  function profile(pid: number, onTestFinished: (cleanup: () => void) => void): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-profile-reuse-'))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'daemon'))
    writeFileSync(join(root, 'daemon', 'daemon-v1.pid'), JSON.stringify({ pid }))
    return root
  }

  async function teardown(
    root: string,
    before: WindowsProcessIdentityRow[],
    after: WindowsProcessIdentityRow[]
  ): Promise<unknown> {
    let table = before
    __setDaemonProcessTableReaderForTests(async () => table)
    await recordProfileDaemons(root)
    table = after
    vi.mocked(cleanupDaemonForProtocol).mockResolvedValueOnce({ cleaned: true, killedCount: 1 })
    vi.useFakeTimers()
    const result = killProfileDaemons(root).then(
      () => null,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(10_100)
    return result
  }

  const leaked = (names: string) => ({
    errors: [expect.objectContaining({ message: `Daemon descendants did not exit: ${names}` })]
  })

  it('ignores a process that predates the daemon whose pid it names as parent', async ({
    onTestFinished
  }) => {
    const daemonPid = await exitedPid()
    const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: 5_000 }
    const system = [
      { pid: 600, ppid: daemonPid, name: 'wininit.exe', creationTimeMs: 10 },
      { pid: 700, ppid: 600, name: 'services.exe', creationTimeMs: 20 }
    ]
    const root = profile(daemonPid, onTestFinished)
    expect(await teardown(root, [daemon, ...system], system)).toBeNull()
  })

  it('still fails on a child the daemon started and left running', async ({ onTestFinished }) => {
    const daemonPid = await exitedPid()
    const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: 5_000 }
    const child = { pid: 77, ppid: daemonPid, name: 'OpenConsole.exe', creationTimeMs: 6_000 }
    const root = profile(daemonPid, onTestFinished)
    expect(await teardown(root, [daemon, child], [child])).toMatchObject(
      leaked(`OpenConsole.exe 77 (ppid ${daemonPid}, created 6000)`)
    )
  })

  it('still fails on a grandchild chain created after the daemon', async ({ onTestFinished }) => {
    const daemonPid = await exitedPid()
    const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: 5_000 }
    const child = { pid: 77, ppid: daemonPid, name: 'OpenConsole.exe', creationTimeMs: 6_000 }
    const grandchild = { pid: 88, ppid: 77, name: 'pwsh.exe', creationTimeMs: 7_000 }
    const root = profile(daemonPid, onTestFinished)
    expect(await teardown(root, [daemon, child, grandchild], [grandchild])).toMatchObject(
      leaked('pwsh.exe 88 (ppid 77, created 7000)')
    )
  })

  it('ignores an older process whose reused parent pid belongs to an exited daemon child', async ({
    onTestFinished
  }) => {
    const daemonPid = await exitedPid()
    const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: 5_000 }
    const child = { pid: 2_000, ppid: daemonPid, name: 'OpenConsole.exe', creationTimeMs: 6_000 }
    const telemetry = { pid: 2_904, ppid: 2_000, name: 'vctip.exe', creationTimeMs: 1_000 }
    const root = profile(daemonPid, onTestFinished)
    expect(await teardown(root, [daemon, child, telemetry], [telemetry])).toBeNull()
  })

  it('ignores children of a newer process that reused the exited daemon pid', async ({
    onTestFinished
  }) => {
    const daemonPid = await exitedPid()
    const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: 5_000 }
    const orphan = { pid: 77, ppid: daemonPid, name: 'OpenConsole.exe', creationTimeMs: 6_000 }
    const linker = { pid: daemonPid, ppid: 1, name: 'link.exe', creationTimeMs: 9_000 }
    const telemetry = { pid: 2_904, ppid: daemonPid, name: 'vctip.exe', creationTimeMs: 9_500 }
    const root = profile(daemonPid, onTestFinished)
    expect(await teardown(root, [daemon, orphan], [linker, orphan, telemetry])).toMatchObject(
      leaked(`OpenConsole.exe 77 (ppid ${daemonPid}, created 6000)`)
    )
  })

  it.for([
    { daemonCreated: undefined, childCreated: 10 },
    { daemonCreated: 5_000, childCreated: undefined }
  ])(
    'keeps a child when a creation time is unknown (%o)',
    async ({ daemonCreated, childCreated }, { onTestFinished }) => {
      const daemonPid = await exitedPid()
      const daemon = { pid: daemonPid, ppid: 1, name: 'node.exe', creationTimeMs: daemonCreated }
      const child = {
        pid: 77,
        ppid: daemonPid,
        name: 'OpenConsole.exe',
        creationTimeMs: childCreated
      }
      const root = profile(daemonPid, onTestFinished)
      expect(await teardown(root, [daemon, child], [child])).toMatchObject(
        leaked(`OpenConsole.exe 77 (ppid ${daemonPid}, created ${childCreated})`)
      )
    }
  )
})
