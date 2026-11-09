import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeClientModule from '../../runtime-client'
import { refuseAgentServerRoute, requirePeerMailCarrier } from './agent-server-route'

const { callerShow } = vi.hoisted(() => ({ callerShow: vi.fn() }))
vi.mock('../../runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeClientModule>()
  return {
    ...actual,
    RuntimeClient: class {
      call = callerShow
    }
  }
})

function ctx(command: string[], flags: [string, string | boolean][]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a handler context with only the fields this function reads.
  return {
    flags: new Map(flags),
    client: { isRemote: true },
    cwd: '/',
    json: false,
    rawArgs: [...command, ...flags.flatMap(([name, value]) => [`--${name}`, String(value)])]
  } as unknown as Parameters<typeof refuseAgentServerRoute>[1]
}

describe('an agent pointing mail at another server', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'launch-token')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca')
    callerShow.mockResolvedValue({ result: { caller: null, terminal: true } })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    callerShow.mockReset()
  })

  it('is refused with the --on command to run instead', async () => {
    await expect(
      refuseAgentServerRoute(
        'send',
        ctx(
          ['orchestration', 'send'],
          [
            ['environment', 'devB'],
            ['to', 'term_b'],
            ['subject', 'hi']
          ]
        )
      )
    ).rejects.toMatchObject({
      code: 'agent_server_route_refused',
      message:
        'send with --environment devB runs on devB and nothing comes back to you. To message an agent on devB, use: orca orchestration send --on devB --to term_b --subject hi'
    })
  })

  it('refuses a check against another server: the mailbox is local', async () => {
    await expect(
      refuseAgentServerRoute('check', ctx(['orchestration', 'check'], [['environment', 'devB']]))
    ).rejects.toMatchObject({
      code: 'mailbox_is_local',
      message:
        'Your mailbox is on this Orca; replies from devB arrive here. Drop --environment devB.'
    })
  })

  it('leaves a person in a shell running the command on that server', async () => {
    vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', '')
    await expect(
      refuseAgentServerRoute('send', ctx(['orchestration', 'send'], [['environment', 'devB']]))
    ).resolves.toBeUndefined()
    expect(callerShow).not.toHaveBeenCalled()
  })

  it('leaves a launch its own Orca does not verify running on that server', async () => {
    callerShow.mockResolvedValue({ result: { caller: null, terminal: false } })
    await expect(
      refuseAgentServerRoute('send', ctx(['orchestration', 'send'], [['environment', 'devB']]))
    ).resolves.toBeUndefined()
  })
})

describe('send --on from an older Orca', () => {
  it('is refused before anything is sent', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ result: { capabilities: ['orchestration.contract.v1'] } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a handler context with only the fields this function reads.
    const context = {
      flags: new Map([['on', 'devB']]),
      client: { call },
      cwd: '/',
      json: false
    } as unknown as Parameters<typeof requirePeerMailCarrier>[0]

    await expect(requirePeerMailCarrier(context)).rejects.toMatchObject({
      code: 'server_mail_unsupported'
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('status.get')
  })
})
