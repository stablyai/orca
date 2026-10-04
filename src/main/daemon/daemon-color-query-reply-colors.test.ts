import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { _resetPtyOwnerHostColorsForTest } from '../../shared/pty-owner-color-query-colors'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

const QUERY = '\x1b]11;?\x07'

describe('daemon OSC 10/11 colours', () => {
  let harness: DaemonAdapterHarness
  let subprocess: ReturnType<typeof createMockSubprocess>
  let secondAdapter: DaemonPtyAdapter | null = null

  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
  })

  afterEach(async () => {
    secondAdapter?.dispose()
    secondAdapter = null
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    _resetPtyOwnerHostColorsForTest()
  })

  it('answers from the default theme until colours are pushed, then from the latest push', async () => {
    await harness.adapter.spawn({ cols: 80, rows: 24 })

    subprocess._simulateData(QUERY)
    await waitFor(() => subprocess.write.mock.calls.length === 1)
    harness.adapter.setColorQueryReplyColors({ foreground: '#000000', background: '#123456' })
    // Why a second query to wait on: the push is a fire-and-forget notification.
    await waitFor(() => {
      subprocess._simulateData(QUERY)
      return subprocess.write.mock.calls.some(
        ([reply]) => reply === '\x1b]11;rgb:1212/3434/5656\x1b\\'
      )
    })

    expect(subprocess.write.mock.calls[0]).toEqual(['\x1b]11;rgb:2828/2c2c/3434\x1b\\'])
  })

  it('resends the last colours when an adapter connects, so a push made while offline lands', async () => {
    secondAdapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    secondAdapter.setColorQueryReplyColors({ foreground: '#000000', background: '#abcdef' })
    await secondAdapter.spawn({ cols: 80, rows: 24 })

    await waitFor(() => {
      subprocess._simulateData(QUERY)
      return subprocess.write.mock.calls.some(
        ([reply]) => reply === '\x1b]11;rgb:abab/cdcd/efef\x1b\\'
      )
    })
    // The value is daemon-wide: a session another client spawned answers the same way.
    await harness.adapter.spawn({ cols: 80, rows: 24 })
    subprocess._simulateData(QUERY)
    await waitFor(() => subprocess.write.mock.calls.length === 1)
    expect(subprocess.write.mock.calls[0]).toEqual(['\x1b]11;rgb:abab/cdcd/efef\x1b\\'])
  })
})
