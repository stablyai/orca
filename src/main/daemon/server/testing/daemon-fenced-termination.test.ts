import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../../providers/adapter/daemon-pty-adapter'
import { DaemonPtyRouter } from '../../providers/routing/daemon-pty-router'
import { DaemonServer } from '../daemon-server'
import { getDaemonSocketPath } from '../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { IDLE_FENCED_TERMINATION_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import { createProcessTableSnapshotReader } from '../../../../shared/process-observation/tables/process-snapshot-cache'
import { inspectSpawnFileChildProcessesFromRows } from '../../pty-subprocess/spawn-file-child-processes'

function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | undefined
  return {
    pid: 999_999_999,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: () => notifyExit?.(0),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => notifyExit?.(137)),
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
}

async function startDaemonAdapterHarness(spawnSubprocess: () => SubprocessHandle) {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-fenced-termination-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess,
    hostTerminalLedgerDir: join(dir, 'terminals')
  })
  await server.start()
  return { dir, server, adapter: new DaemonPtyAdapter({ socketPath, tokenPath }) }
}

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
afterEach(async () => {
  if (harness) {
    await harness.adapter.disconnectOnly()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    harness = undefined
  }
})

describe('fenced daemon kill protocol', () => {
  it('advertises idle protection separately from manual fenced termination for older owners', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const olderOwner = new DaemonPtyAdapter({
      socketPath: '/unused',
      tokenPath: '/unused',
      protocolVersion: IDLE_FENCED_TERMINATION_PROTOCOL_VERSION - 1
    })
    vi.spyOn(olderOwner, 'listProcesses').mockResolvedValue([
      { id: 'old-pty', incarnationId: 'old', cwd: '', title: 'old' }
    ])
    const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [olderOwner] })
    const current = await router.spawn({ sessionId: 'current-pty', cols: 80, rows: 24 })
    await router.listProcesses()
    expect(router.supportsFencedTermination('old-pty')).toBe(true)
    expect(router.supportsFencedTermination('old-pty', true)).toBe(false)
    expect(router.supportsFencedTermination(current.id, true)).toBe(true)
    olderOwner.dispose()
  })

  it('keeps the terminal open if work starts before an automatic workspace end', async () => {
    const handle = createMockSubprocess()
    harness = await startDaemonAdapterHarness(() => handle)
    const created = await harness.adapter.spawn({ sessionId: 'pty', cols: 80, rows: 24 })
    if (!created.incarnationId) {
      throw new Error('Expected incarnation')
    }
    vi.spyOn(harness.server.host, 'inspectProcess').mockResolvedValue({
      foregroundProcess: 'sleep',
      hasChildProcesses: true,
      runningWork: 'running'
    })
    const request = {
      id: 'pty',
      expectedIncarnationId: created.incarnationId,
      requireNoAgentOwner: true,
      requireUnattached: false
    }
    await expect(harness.adapter.killFenced({ ...request, requireIdle: true })).resolves.toEqual({
      outcome: 'refused',
      reason: 'running_work'
    })
    expect(handle.forceKill).not.toHaveBeenCalled()
    await expect(harness.adapter.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
  })

  it('requires confirmation for extra processes in an otherwise idle shell launch chain', () => {
    const terminal = { tty: 'ttys001', tpgid: 103, stat: 'S' }
    const login = { ...terminal, pid: 101, ppid: 1, pgid: 101, command: 'login' }
    const wrapper = { ...terminal, pid: 102, ppid: 101, pgid: 102, command: 'wrapper' }
    const shell = { ...terminal, pid: 103, ppid: 101, pgid: 103, command: '-zsh' }
    const teardown = { shellIsRootChild: true }
    expect(inspectSpawnFileChildProcessesFromRows([login, shell], 101, 'zsh', teardown)).toBe(
      'no-children'
    )
    expect(
      inspectSpawnFileChildProcessesFromRows(
        [login, wrapper, { ...shell, ppid: 102 }],
        101,
        'zsh',
        teardown
      )
    ).toBe('unverifiable')
  })

  it('drops an abandoned process inspection before it can start a new capture', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const terminal = await harness.adapter.spawn({ sessionId: 'pty', cols: 80, rows: 24 })
    const prior = Promise.withResolvers<string>()
    const capture = vi.fn().mockReturnValueOnce(prior.promise).mockResolvedValue('new')
    const reader = createProcessTableSnapshotReader({ runPs: capture, now: () => 100 })
    const previous = reader.getSnapshot()
    const admitted = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    vi.spyOn(harness.server.host, 'inspectProcess').mockImplementation(async (_id, options) => {
      admitted.resolve()
      try {
        await reader.getSnapshotWithAge(101, options?.signal)
        return { foregroundProcess: null, hasChildProcesses: true }
      } finally {
        finished.resolve()
      }
    })
    const abort = new AbortController()
    const inspection = harness.adapter.inspectProcess('pty', {
      expectedIncarnationId: terminal.incarnationId,
      runningWorkSinceMs: 101,
      signal: abort.signal
    })
    await Promise.race([admitted.promise, inspection])
    abort.abort()
    await expect(inspection).rejects.toThrow('client_disconnected')
    await harness.adapter.listProcesses()
    prior.resolve('old')
    await previous
    await finished.promise
    expect(capture).toHaveBeenCalledOnce()
  })
})
