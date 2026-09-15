import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import type { TerminalSnapshot } from './types'

let harness: DaemonAdapterHarness
let attached: DaemonPtyAdapter
let subprocess: ReturnType<typeof createMockSubprocess>

beforeEach(async () => {
  harness = await startDaemonAdapterHarness(() => {
    subprocess = createMockSubprocess()
    return subprocess
  })
  attached = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  })
})

afterEach(async () => {
  attached?.dispose()
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

it.each(['spawn', 'attach'] as const)(
  'keeps the %s stream baseline when history overlay captures newer output',
  async (operation) => {
    const sessionId = 'overlay-sequence'
    const initialData = 'before attach\r\n'
    const duringOverlay = 'x'.repeat(459)
    await harness.adapter.spawn({ sessionId, cols: 80, rows: 24 })
    let initialReceived = ''
    harness.adapter.onData(({ data }) => (initialReceived += data))
    subprocess._simulateData(initialData)
    await waitFor(() => initialReceived === initialData)
    await harness.adapter.disconnectOnly()

    let streamedChars = 0
    attached.onData(({ data, sequenceChars }) => {
      streamedChars += sequenceChars ?? data.length
    })
    const overlayTarget = attached as unknown as {
      overlayDurableRestoreSnapshot(
        id: string,
        snapshot: TerminalSnapshot
      ): Promise<TerminalSnapshot>
    }
    const originalOverlay = overlayTarget.overlayDurableRestoreSnapshot.bind(attached)
    let overlaySequence: number | undefined
    vi.spyOn(overlayTarget, 'overlayDurableRestoreSnapshot').mockImplementationOnce(
      async (id, snapshot) => {
        subprocess._simulateData(duringOverlay)
        await waitFor(() => streamedChars === duringOverlay.length)
        const restored = await originalOverlay(id, snapshot)
        overlaySequence = restored.outputSequence
        return restored
      }
    )

    const result =
      operation === 'attach'
        ? await attached.attach(sessionId)
        : await attached.spawn({ sessionId, cols: 80, rows: 24, attachOnly: true })
    expect(overlaySequence).toBe(initialData.length + duringOverlay.length)
    expect(result?.providerSequence).toEqual({
      value: initialData.length,
      generation: 'continued'
    })
    const runtimeSequence = result!.providerSequence!.value + streamedChars
    const recovery = await attached.getBufferSnapshot(sessionId, { scrollbackRows: 0 })
    expect(recovery?.seq).toBe(runtimeSequence)

    const nextOutput = 'next frame\r\n'
    subprocess._simulateData(nextOutput)
    await waitFor(() => streamedChars === duringOverlay.length + nextOutput.length)
    const nextSequence = result!.providerSequence!.value + streamedChars
    expect(nextSequence - nextOutput.length).toBe(recovery?.seq)
  }
)
