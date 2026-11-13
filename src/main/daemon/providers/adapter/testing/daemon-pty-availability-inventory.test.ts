import { rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from '../../../server/daemon-server'

function omitIncarnation(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result
  }
  if ('incarnationId' in result) {
    const { incarnationId: _incarnation, ...legacy } = result
    return legacy
  }
  if ('sessions' in result && Array.isArray(result.sessions)) {
    return { ...result, sessions: result.sessions.map(omitIncarnation) }
  }
  return result
}

function createInputClosableSubprocess() {
  let inputClosed = false
  let onInputClosed: ((reason: string) => void) | undefined
  return {
    ...createMockSubprocess(),
    isInputClosed: () => inputClosed,
    onInputClosed: (callback: (reason: string) => void) => {
      onInputClosed = callback
    },
    closeInput: () => {
      inputClosed = true
      onInputClosed?.('master_closed')
    }
  }
}

function holdInventoryResponses(server: DaemonServer, beforeSnapshot = false, legacy = false) {
  const router = server['requestRouter']
  const route = router.route.bind(router)
  const pending: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const spy = vi.spyOn(router, 'route').mockImplementation(async (clientId, request) => {
    const read = async () => {
      const result = await route(clientId, request)
      return legacy ? omitIncarnation(result) : result
    }
    if (request.type !== 'listSessions') {
      return read()
    }
    const response = Promise.withResolvers<void>()
    const result = beforeSnapshot ? undefined : await read()
    pending.push(response)
    await response.promise
    if (beforeSnapshot) {
      return read()
    }
    return result
  })
  return {
    pending,
    dispose: () => {
      pending.forEach((response) => response.resolve())
      spy.mockRestore()
    }
  }
}

async function withRetainedPty(
  run: (context: {
    owner: DaemonPtyAdapter
    subprocess: ReturnType<typeof createInputClosableSubprocess>
    subprocesses: ReturnType<typeof createInputClosableSubprocess>[]
    peer: DaemonPtyAdapter
    responses: ReturnType<typeof holdInventoryResponses>
  }) => Promise<void>,
  beforeSnapshot = false,
  legacy = false
) {
  const subprocesses: ReturnType<typeof createInputClosableSubprocess>[] = []
  const harness = await startDaemonAdapterHarness(() => {
    const subprocess = createInputClosableSubprocess()
    subprocesses.push(subprocess)
    return subprocess
  })
  const owner = new DaemonPtyAdapter(harness)
  const peer = new DaemonPtyAdapter(harness)
  let responses: ReturnType<typeof holdInventoryResponses> | undefined
  try {
    await harness.adapter.spawn({ sessionId: 'retained', cwd: '/tmp', cols: 80, rows: 24 })
    const subprocess = subprocesses[0]
    if (!subprocess) {
      throw new Error('Expected the retained subprocess')
    }
    harness.adapter.dispose()
    await owner.listProcesses()
    expect(owner.hasPty('retained')).toBe(false)
    expect(owner.getPtyAvailability('retained')).toBe(true)
    responses = holdInventoryResponses(harness.server, beforeSnapshot, legacy)
    await run({ owner, subprocess, subprocesses, peer, responses })
  } finally {
    responses?.dispose()
    owner.dispose()
    peer.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  }
}

it('uses confirmed replacement identity after an old owner closes input and is explicitly closed', async () => {
  await withRetainedPty(async ({ owner, peer, subprocess, subprocesses, responses }) => {
    await owner.attach('retained')
    subprocess.closeInput()
    await waitFor(() => owner.getPtyAvailability('retained') === false)
    const stream = owner['client']['streamSocket']
    if (!stream) {
      throw new Error('Expected the event stream')
    }
    stream.pause()
    await owner.shutdown('retained', { immediate: true })
    const replacement = await peer.spawn({ sessionId: 'retained', cwd: '/tmp', cols: 80, rows: 24 })
    expect(replacement.isReattach).not.toBe(true)
    const inventory = owner.listProcesses()
    await waitFor(() => responses.pending.length === 1)
    responses.pending[0]?.resolve()
    await expect(inventory).resolves.toMatchObject([{ incarnationId: replacement.incarnationId }])
    expect(owner.hasPty('retained')).toBe(false)
    expect(owner.getPtyAvailability('retained')).toBe(true)
    await expect(owner.writeWithSettlement('retained', 'live')).resolves.toMatchObject({
      outcome: 'accepted'
    })
    await waitFor(() => subprocesses[1]?.write.mock.calls.length === 1)
    expect(subprocesses[1]?.write).toHaveBeenCalledWith('live')
  })
})
