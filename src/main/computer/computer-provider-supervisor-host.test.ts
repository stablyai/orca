import { describe, expect, it, vi } from 'vitest'
import { ComputerProviderSupervisorHost } from './computer-provider-supervisor-host'
import { COMPUTER_PROVIDER_SUPERVISOR_CHANNEL } from './computer-provider-supervisor-protocol'

function macOSSupervisor() {
  return {
    start: vi.fn(() => ({
      sessionId: 'session-1',
      socketPath: '/tmp/session-1/provider.sock',
      socketToken: 'token-1'
    })),
    claim: vi.fn(),
    release: vi.fn(),
    shutdown: vi.fn()
  }
}

function desktopSupervisor() {
  return {
    execute: vi.fn(async () => ({ stdout: '{"ok":true}', stderr: '', error: null })),
    shutdown: vi.fn()
  }
}

describe('ComputerProviderSupervisorHost', () => {
  it('routes only fixed domain operations and returns their bounded result', async () => {
    const macOS = macOSSupervisor()
    const host = new ComputerProviderSupervisorHost(macOS as never)
    const sent: unknown[] = []
    host.attach((message) => sent.push(message))

    expect(
      host.handle({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'macos.start',
        params: {}
      })
    ).toBe(true)
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(macOS.start).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      {
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'response',
        id: 1,
        ok: true,
        result: {
          sessionId: 'session-1',
          socketPath: '/tmp/session-1/provider.sock',
          socketToken: 'token-1'
        }
      }
    ])
  })

  it('routes validated desktop requests without accepting invocation fields', async () => {
    const macOS = macOSSupervisor()
    const desktop = desktopSupervisor()
    const host = new ComputerProviderSupervisorHost(macOS as never, desktop as never)
    const sent: unknown[] = []
    host.attach((message) => sent.push(message))

    expect(
      host.handle({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 2,
        method: 'desktop.execute',
        params: { request: { tool: 'list_apps' } }
      })
    ).toBe(true)
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(desktop.execute).toHaveBeenCalledWith({ tool: 'list_apps' })
    expect(sent).toEqual([
      expect.objectContaining({
        id: 2,
        ok: true,
        result: { stdout: '{"ok":true}', stderr: '', error: null }
      })
    ])

    expect(
      host.handle({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 3,
        method: 'desktop.execute',
        params: {
          request: { tool: 'list_apps' },
          command: '/tmp/untrusted',
          args: ['--anything']
        }
      })
    ).toBe(false)
    expect(desktop.execute).toHaveBeenCalledTimes(1)
  })

  it('does not deliver a stale operation response to a replacement owner', async () => {
    type DesktopResult = { stdout: string; stderr: string; error: null }
    let resolveExecution = (_result: DesktopResult): void => {}
    const desktop = desktopSupervisor()
    desktop.execute.mockImplementationOnce(
      () =>
        new Promise<DesktopResult>((resolve) => {
          resolveExecution = resolve
        })
    )
    const host = new ComputerProviderSupervisorHost(macOSSupervisor() as never, desktop as never)
    const originalSend = vi.fn()
    const replacementSend = vi.fn()
    host.attach(originalSend)
    host.handle({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'request',
      id: 4,
      method: 'desktop.execute',
      params: { request: { tool: 'list_apps' } }
    })

    host.shutdown()
    host.attach(replacementSend)
    resolveExecution({ stdout: '{"ok":true}', stderr: '', error: null })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(originalSend).not.toHaveBeenCalled()
    expect(replacementSend).not.toHaveBeenCalled()
  })

  it('rejects arbitrary executable and argument fields at the protocol boundary', () => {
    const macOS = macOSSupervisor()
    const host = new ComputerProviderSupervisorHost(macOS as never)

    expect(
      host.handle({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'macos.start',
        params: { executablePath: '/tmp/untrusted', args: ['--anything'] }
      })
    ).toBe(false)
    expect(macOS.start).not.toHaveBeenCalled()
  })

  it('kills all sessions and detaches delivery when the owner shuts down', () => {
    const macOS = macOSSupervisor()
    const desktop = desktopSupervisor()
    const host = new ComputerProviderSupervisorHost(macOS as never, desktop as never)
    const send = vi.fn()
    host.attach(send)

    host.shutdown()

    expect(macOS.shutdown).toHaveBeenCalledTimes(1)
    expect(desktop.shutdown).toHaveBeenCalledTimes(1)
    expect(
      host.handle({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 2,
        method: 'macos.start',
        params: {}
      })
    ).toBe(false)
    expect(macOS.start).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
