import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { preparePendingSplitClose } from '../../../src/renderer/src/components/terminal-pane/pending-split-close-test-fixture'
import {
  startDaemonAdapterHarness,
  createMockSubprocess
} from '../../../src/main/daemon/daemon-pty-adapter-test-harness'
import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import { getHistorySessionDirName } from '../../../src/main/daemon/history-paths'
import { SessionNotFoundError } from '../../../src/main/daemon/types'

async function coldRestoreHarness() {
  const subprocess = createMockSubprocess()
  const h = await startDaemonAdapterHarness(() => subprocess)
  const historyPath = join(h.dir, 'history')
  const sessionDir = join(historyPath, getHistorySessionDirName('pty-restored'))
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({
      cwd: h.dir,
      cols: 80,
      rows: 24,
      startedAt: '2026-04-15T10:00:00Z',
      endedAt: null,
      exitCode: null
    })
  )
  writeFileSync(join(sessionDir, 'scrollback.bin'), 'synthetic saved history\r\n')
  const adapter = new DaemonPtyAdapter({
    socketPath: h.socketPath,
    tokenPath: h.tokenPath,
    historyPath
  })
  const requests: Promise<void>[] = []
  const absent: string[] = []
  const bridgeKill = (id: string): Promise<void> => {
    const request = adapter.shutdown(id, { immediate: true }).catch((error) => {
      // The renderer IPC handler treats the provider's already-gone reply as success.
      if (error instanceof SessionNotFoundError) {
        absent.push(id)
        return
      }
      throw error
    })
    requests.push(request)
    return request
  }
  return {
    adapter,
    subprocess,
    requests,
    absent,
    bridgeKill,
    async dispose() {
      adapter.dispose()
      h.adapter.dispose()
      await h.server.shutdown()
      rmSync(h.dir, { recursive: true, force: true })
    }
  }
}

it('explicit split close retires a real daemon cold restore whose reply is pending', async () => {
  const h = await coldRestoreHarness()
  try {
    const p = await preparePendingSplitClose()
    vi.mocked(window.api.pty.kill).mockImplementation(h.bridgeKill)
    const result = await h.adapter.spawn({ cols: 80, rows: 24, sessionId: 'pty-restored' })
    expect(result.isReattach).not.toBe(true)
    expect(result.coldRestore).toBeDefined()
    expect(await h.adapter.probePtyLiveness('pty-restored')).toBe(true)
    p.actions.executeClosePane(1)
    p.spawn.resolve(result)
    await p.connecting
    await Promise.all(h.requests)
    expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
    expect(h.subprocess.forceKill).toHaveBeenCalledOnce()
    expect(await h.adapter.probePtyLiveness('pty-restored')).toBe(false)
  } finally {
    await h.dispose()
  }
})

it('the explicit late reply retries a kill that completed before adapter admission', async () => {
  const h = await coldRestoreHarness()
  try {
    const p = await preparePendingSplitClose()
    vi.mocked(window.api.pty.kill).mockImplementation(h.bridgeKill)
    p.actions.executeClosePane(1)
    // Hold admission outside the adapter; there is no history lock or session yet.
    await Promise.all(h.requests)
    expect(h.absent).toEqual(['pty-restored'])
    const result = await h.adapter.spawn({ cols: 80, rows: 24, sessionId: 'pty-restored' })
    expect(result.coldRestore).toBeDefined()
    expect(await h.adapter.probePtyLiveness('pty-restored')).toBe(true)
    p.spawn.resolve(result)
    await p.connecting
    await Promise.all(h.requests)
    expect(window.api.pty.kill).toHaveBeenCalledTimes(2)
    expect(await h.adapter.probePtyLiveness('pty-restored')).toBe(false)
  } finally {
    await h.dispose()
  }
})

it('a known-ID shutdown already admitted to the adapter waits for its spawn history lock', async () => {
  const h = await coldRestoreHarness()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finish = h.adapter['finishSpawn'].bind(h.adapter)
  h.adapter['finishSpawn'] = async (context, result) => {
    started.resolve()
    await release.promise
    return finish(context, result)
  }
  try {
    const spawning = h.adapter.spawn({ cols: 80, rows: 24, sessionId: 'pty-restored' })
    await started.promise
    const stopping = h.adapter.shutdown('pty-restored', { immediate: true })
    expect(h.subprocess.forceKill).not.toHaveBeenCalled()
    release.resolve()
    await spawning
    await stopping
    expect(await h.adapter.probePtyLiveness('pty-restored')).toBe(false)
    expect(h.subprocess.forceKill).toHaveBeenCalledOnce()
  } finally {
    release.resolve()
    await h.dispose()
  }
})
