import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import { ENVIRONMENT_HANDLERS } from './environment'

const printResultMock = vi.hoisted(() => vi.fn())
const listEnvironmentsMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('../output/command-result-output', () => ({ printResult: printResultMock }))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))
vi.mock('../runtime/profile/metadata', () => ({
  getDefaultUserDataPath: () => '/tmp/orca-user-data'
}))

function fakeClient(call: (method: string, params?: unknown) => Promise<unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only use call.
  return { call } as unknown as HandlerContext['client']
}

function handlerContext(
  flags: [string, string | boolean][],
  client: HandlerContext['client'],
  json = true
): HandlerContext {
  return { flags: new Map(flags), client, cwd: '/tmp/repo', json }
}

function ok(result: unknown) {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'local' } }
}

function methodNotFound(method: string): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_old',
    ok: false,
    error: { code: 'method_not_found', message: `Unknown method: ${method}` },
    _meta: { runtimeId: 'runtime-1' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('orca host add handler', () => {
  it('maps every flag onto ssh.addTarget and prints the registered id', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'ssh.addTarget') {
        return ok({
          target: {
            id: 'ssh-new',
            label: 'build-host-1',
            host: 'box.example.org',
            port: 2222,
            username: 'dev'
          },
          repoReadoptions: []
        })
      }
      if (method === 'ssh.listEditableTargets') {
        return ok({ targets: [] })
      }
      throw new Error(`unexpected call ${method}`)
    })

    await ENVIRONMENT_HANDLERS['host add'](
      handlerContext(
        [
          ['host', 'box.example.org'],
          ['port', '2222'],
          ['user', 'dev'],
          ['key', '~/.ssh/id_ed25519'],
          ['name', 'build-host-1'],
          ['allow-remote-cli-control', true]
        ],
        fakeClient(call)
      )
    )

    expect(call).toHaveBeenCalledWith('ssh.addTarget', {
      target: {
        label: 'build-host-1',
        host: 'box.example.org',
        port: 2222,
        username: 'dev',
        identityFile: '~/.ssh/id_ed25519',
        allowRemoteCliControl: true
      }
    })
    const printed = printResultMock.mock.calls.at(-1)?.[0]
    expect(printed).toMatchObject({
      ok: true,
      result: { target: { id: 'ssh-new' }, repoReadoptions: [] },
      _meta: { runtimeId: 'local' }
    })
  })

  it('defaults the label to user@host and the port to 22', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'ssh.addTarget') {
        return ok({
          target: { id: 'ssh-new', label: 'dev@box', host: 'box', port: 22, username: 'dev' },
          repoReadoptions: []
        })
      }
      if (method === 'ssh.listEditableTargets') {
        return ok({ targets: [] })
      }
      throw new Error(`unexpected call ${method}`)
    })

    await ENVIRONMENT_HANDLERS['host add'](
      handlerContext(
        [
          ['host', 'box'],
          ['user', 'dev']
        ],
        fakeClient(call)
      )
    )

    expect(call).toHaveBeenCalledWith('ssh.addTarget', {
      target: { label: 'dev@box', host: 'box', port: 22, username: 'dev' }
    })
  })

  it('refuses a port outside the SSH range before calling the runtime', async () => {
    const client = fakeClient(vi.fn())

    await expect(
      ENVIRONMENT_HANDLERS['host add'](
        handlerContext(
          [
            ['host', 'box'],
            ['port', '70000']
          ],
          client
        )
      )
    ).rejects.toBeInstanceOf(RuntimeClientError)
    await expect(
      ENVIRONMENT_HANDLERS['host add'](
        handlerContext(
          [
            ['host', 'box'],
            ['port', '70000']
          ],
          client
        )
      )
    ).rejects.toThrow('--port must be between 1 and 65535.')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects --environment instead of registering on another machine', async () => {
    const client = fakeClient(vi.fn())

    await expect(
      ENVIRONMENT_HANDLERS['host add'](
        handlerContext(
          [
            ['host', 'box'],
            ['environment', 'work-laptop']
          ],
          client
        )
      )
    ).rejects.toThrow('`--environment` does not retarget `orca host add`.')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('translates method_not_found into an incompatible_runtime update hint', async () => {
    const call = vi.fn(async (method: string) => {
      throw methodNotFound(method)
    })

    await expect(
      ENVIRONMENT_HANDLERS['host add'](handlerContext([['host', 'box']], fakeClient(call)))
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message:
        'This Orca runtime cannot register SSH hosts from the CLI. Update Orca on that host and try again.'
    })
  })

  it('warns when a sibling target points at the same host and port', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'ssh.addTarget') {
        return ok({
          target: { id: 'ssh-new', label: 'new', host: 'box', port: 22, username: 'ci' },
          repoReadoptions: []
        })
      }
      if (method === 'ssh.listEditableTargets') {
        return ok({
          targets: [{ id: 'ssh-old', label: 'old', host: 'box', port: 22, username: 'dev' }]
        })
      }
      throw new Error(`unexpected call ${method}`)
    })

    await ENVIRONMENT_HANDLERS['host add'](
      handlerContext(
        [
          ['host', 'box'],
          ['user', 'ci']
        ],
        fakeClient(call),
        false
      )
    )

    const result = printResultMock.mock.calls.at(-1)?.[0].result
    const formatter = printResultMock.mock.calls.at(-1)?.[2]
    expect(formatter(result)).toContain(
      'Warning: An existing target "old" (ssh-old) points at the same box:22.'
    )
  })

  it('reports workspace re-adoption for a removed target id', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'ssh.addTarget') {
        return ok({
          target: { id: 'ssh-new', label: 'box', host: 'box', port: 22, username: '' },
          repoReadoptions: [
            { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['r1', 'r2'] }
          ]
        })
      }
      if (method === 'ssh.listEditableTargets') {
        return ok({ targets: [] })
      }
      throw new Error(`unexpected call ${method}`)
    })

    await ENVIRONMENT_HANDLERS['host add'](
      handlerContext([['host', 'box']], fakeClient(call), false)
    )

    const lastCall = printResultMock.mock.calls.at(-1)
    expect(lastCall?.[2](lastCall?.[0].result)).toContain(
      'Re-pointed 2 workspace(s) from ssh-old to ssh-new.'
    )
  })
})
