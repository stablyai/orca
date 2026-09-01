// P1-14: both terminal-create surfaces must carry the AUTHENTICATED paired
// device into the runtime create options, or two phones share one launch
// admission principal (and one capacity bucket). The device id comes from the
// envelope only — never from params.
import { describe, expect, it, vi } from 'vitest'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext, type RpcMethod } from '../core'
import { TERMINAL_METHODS } from './terminal'
import { SESSION_TAB_METHODS } from './session-tabs'

const AGENT_LAUNCH = {
  selection: { kind: 'agent', agent: 'claude' },
  prompt: 'hi'
}

function method(methods: readonly RpcAnyMethod[], name: string): RpcMethod {
  const found = methods.find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`${name} method missing`)
  }
  return found
}

async function createTerminalOpts(
  ctx: Partial<RpcContext>,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const createTerminal = vi.fn(async (_worktree: unknown, opts: Record<string, unknown>) => ({
    handle: 'terminal-1',
    worktreeId: 'wt-1',
    opts
  }))
  await method(TERMINAL_METHODS, 'terminal.create').handler(
    { worktree: 'id:wt-1', agentLaunch: AGENT_LAUNCH, ...params },
    { runtime: { createTerminal }, ...ctx } as unknown as RpcContext
  )
  return createTerminal.mock.calls[0]![1]
}

async function createMobileTabOpts(
  ctx: Partial<RpcContext>,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const createMobileSessionTerminal = vi.fn(
    async (_worktree: unknown, opts: Record<string, unknown>) => ({
      tab: { id: 'tab-1::leaf-1' },
      opts
    })
  )
  await method(SESSION_TAB_METHODS, 'session.tabs.createTerminal').handler(
    { worktree: 'id:wt-1', agentLaunch: AGENT_LAUNCH, ...params },
    {
      runtime: { createMobileSessionTerminal },
      ...ctx
    } as unknown as RpcContext
  )
  return createMobileSessionTerminal.mock.calls[0]![1]
}

const PATHS: [
  string,
  (ctx: Partial<RpcContext>, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
][] = [
  ['terminal.create', createTerminalOpts],
  ['session.tabs.createTerminal', createMobileTabOpts]
]

describe.each(PATHS)('%s device-scoped agent-launch admission', (_name, optsFor) => {
  it('forwards the authenticated paired device alongside clientKind', async () => {
    const opts = await optsFor({
      clientKind: 'mobile',
      pairedDeviceId: 'device-a'
    })

    expect(opts).toMatchObject({
      clientKind: 'mobile',
      deviceId: 'device-a'
    })
  })

  it('omits deviceId (never undefined-valued) when no device is paired', async () => {
    // An omitted id keeps the coarse principal pre-device rows were admitted
    // under, so they stay forgettable after the upgrade.
    const opts = await optsFor({ clientKind: 'mobile' })

    expect(opts.clientKind).toBe('mobile')
    expect('deviceId' in opts).toBe(false)
  })

  it('takes the device id from the envelope, never from client params', async () => {
    const opts = await optsFor(
      { clientKind: 'mobile', pairedDeviceId: 'device-a' },
      { deviceId: 'device-victim' }
    )

    expect(opts.deviceId).toBe('device-a')
  })
})
