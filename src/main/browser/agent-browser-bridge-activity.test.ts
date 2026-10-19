import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/app', getAppPath: () => '/project', isPackaged: false }
}))

vi.mock('./cdp-ws-proxy', () => ({ CdpWsProxy: vi.fn() }))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup
} from './agent-browser-bridge-test-harness'

const ensureSession = vi.fn(async () => {})

class ActivityBridge extends AgentBrowserBridge {
  protected override async ensureSession(): Promise<void> {
    await ensureSession()
  }

  run<T>(page: string, execute: () => Promise<T>): Promise<T> {
    return this.enqueueTargetedCommand(undefined, page, execute)
  }
}

describe('agent browser command activity', () => {
  beforeEach(() => {
    ensureSession.mockReset()
    ensureSession.mockResolvedValue(undefined)
  })

  function setup() {
    const release = vi.fn()
    const hold = vi.fn(() => release)
    const bridge = new ActivityBridge(
      mockBrowserManager(
        new Map([
          ['page-a', 1],
          ['page-b', 2]
        ]),
        new Map(),
        { holdAutomationActivity: hold }
      )
    )
    overrideBridgeWebContentsLookup(
      bridge,
      vi.fn((id) => mockWebContents(id))
    )
    return { bridge, hold, release }
  }

  it('marks the resolved target before session setup and releases after the command', async () => {
    const { bridge, hold, release } = setup()
    const gate = Promise.withResolvers<string>()
    ensureSession.mockImplementationOnce(async () => {
      expect(hold).toHaveBeenCalledWith(2)
      expect(release).not.toHaveBeenCalled()
    })
    const pending = bridge.run('page-b', () => gate.promise)
    await vi.waitFor(() => expect(ensureSession).toHaveBeenCalled())
    expect(release).not.toHaveBeenCalled()
    gate.resolve('done')
    await expect(pending).resolves.toBe('done')
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['session', 'command'])('releases after a %s failure', async (failure) => {
    const { bridge, hold, release } = setup()
    const error = new Error('failed')
    if (failure === 'session') {
      ensureSession.mockRejectedValueOnce(error)
    }
    await expect(
      bridge.run('page-a', async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(hold).toHaveBeenCalledWith(1)
    expect(release).toHaveBeenCalledOnce()
  })

  it('never marks the old page while switching to another page', async () => {
    const { bridge, hold } = setup()
    await expect(bridge.tabSwitch(undefined, undefined, 'page-b')).resolves.toMatchObject({
      browserPageId: 'page-b'
    })
    expect(hold).not.toHaveBeenCalled()
  })

  it('keeps queued commands inactive until they actually execute', async () => {
    const { bridge, hold, release } = setup()
    const gate = Promise.withResolvers<void>()
    const first = bridge.run('page-a', () => gate.promise)
    const second = bridge.run('page-a', async () => 'second')
    expect(hold).toHaveBeenCalledTimes(1)
    gate.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBe('second')
    expect(hold).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
  })
})
