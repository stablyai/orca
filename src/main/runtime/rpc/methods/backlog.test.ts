import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { DeviceRegistry } from '../../device-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BACKLOG_METHODS } from './backlog'
import { routeBacklogOperation } from '../../../backlog/backlog-host'

vi.mock('../../../backlog/backlog-host', () => ({
  routeBacklogOperation: vi.fn().mockResolvedValue({ saved: true })
}))

const repo = {
  id: 'host-project',
  path: '/host/project',
  kind: 'folder',
  displayName: 'Project',
  addedAt: 0,
  badgeColor: ''
}
const listRepos = vi.fn(() => [repo])
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scoped server/dispatcher fixtures use only metadata setup, getRuntimeId and listRepos, implemented below.
const runtime = {
  /** Keeps unrelated notification persistence out of the admission fixture. */
  configureNotificationDismissalStore: () => {},
  /** Supplies a stable server identity without starting a real runtime. */
  getRuntimeId: () => 'host',
  listRepos
} as unknown as OrcaRuntimeService

it('resolves a registered project on the server and refuses forged paths, unknown IDs and invalid mutations', async () => {
  const dispatcher = new RpcDispatcher({ runtime, methods: BACKLOG_METHODS })
  /** Exercises dispatcher validation separately from the transport-authentication test below. */
  const send = (params: unknown) =>
    dispatcher.dispatch({ id: 'request', authToken: 'test', method: 'backlog.execute', params })
  const operation = {
    kind: 'create',
    title: '--literal',
    description: 'Description',
    status: 'Review'
  }
  expect(await send({ repoId: 'host-project', repoPath: '/attacker', operation })).toMatchObject({
    ok: true
  })
  expect(routeBacklogOperation).toHaveBeenCalledWith(repo, operation)
  vi.mocked(routeBacklogOperation).mockClear()
  expect(await send({ repoId: 'unknown', operation })).toMatchObject({ ok: false })
  expect(
    await send({ repoId: 'host-project', operation: { kind: 'edit', id: '../../task' } })
  ).toMatchObject({ ok: false })
  expect(routeBacklogOperation).not.toHaveBeenCalled()
})

it('applies transport authentication and paired-device scope before registered-repo routing', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-backlog-auth-'))
  listRepos.mockClear()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    methods: BACKLOG_METHODS,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const mobile = server['deviceRegistry'].addDevice('phone', 'mobile')
  const desktop = server['deviceRegistry'].addDevice('desktop', 'runtime')
  const request = {
    id: 'backlog-auth',
    method: 'backlog.execute',
    params: { repoId: repo.id, repoPath: '/forged', operation: { kind: 'read', id: 'TASK-1' } }
  }
  const replies: unknown[] = []
  vi.mocked(routeBacklogOperation).mockClear()
  try {
    for (const authToken of [undefined, 'invalid']) {
      expect(
        await server['handleMessage'](JSON.stringify({ ...request, authToken }))
      ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    }
    for (const [channelToken, requestToken, expectedCode] of [
      [undefined, undefined, 'unauthorized'],
      ['invalid', undefined, 'unauthorized'],
      [mobile.token, desktop.token, 'unauthorized'],
      [mobile.token, undefined, 'forbidden']
    ]) {
      await server['handleWebSocketMessage'](
        JSON.stringify({ ...request, deviceToken: requestToken }),
        (response) => replies.push(JSON.parse(response)),
        () => {},
        undefined,
        undefined,
        channelToken
      )
      expect(replies.at(-1)).toMatchObject({ ok: false, error: { code: expectedCode } })
    }
    expect(listRepos).not.toHaveBeenCalled()
    expect(routeBacklogOperation).not.toHaveBeenCalled()

    await server['handleWebSocketMessage'](
      JSON.stringify(request),
      (response) => replies.push(JSON.parse(response)),
      () => {},
      undefined,
      undefined,
      desktop.token
    )
    expect(replies.at(-1)).toMatchObject({ ok: true })
    expect(routeBacklogOperation).toHaveBeenCalledExactlyOnceWith(repo, {
      kind: 'read',
      id: 'TASK-1'
    })
  } finally {
    await server.stop()
    await rm(userDataPath, { recursive: true, force: true })
  }
})
