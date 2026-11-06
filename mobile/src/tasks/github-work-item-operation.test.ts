import { expect, it } from 'vitest'
import { withGitHubTargetOperation } from './github-work-item-operation'
import { githubIssueUpdate } from './mobile-task-item-state-operations'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { GITHUB_DESKTOP_UPDATE_REQUIRED } from '../transport/github-target-invocation'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as capability } from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function physical(runtimeId: string, capable = true) {
  const reachedWait = deferred(),
    resume = deferred()
  let waits = 0,
    sequence = 0,
    pause = false
  const writes: unknown[] = []
  const client = createFakeRpcClient()
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++sequence),
    getState: client.getState,
    waitForConnected: async () => {
      if (++waits > 1 && pause) {
        reachedWait.resolve()
        await resume.promise
      }
    },
    sendFrame: (frame) => {
      if (frame.method !== 'status.get') {
        writes.push(frame)
      }
      queueMicrotask(() =>
        tracker.resolve({
          id: frame.id,
          ok: true,
          result:
            frame.method === 'status.get'
              ? {
                  runtimeId,
                  hostDescriptor: { installationId: runtimeId },
                  capabilities: capable ? [capability] : []
                }
              : { ok: true }
        })
      )
      return true
    }
  })
  client.sendRequest = (method, params, options) => tracker.sendRequest(method, params, options)
  client.close = () => {
    client.pushState('disconnected')
    tracker.rejectAll('Closed')
  }
  return {
    client,
    writes,
    reachedWait,
    resume,
    pause: () => {
      pause = true
    }
  }
}
const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
async function update(
  client: ReturnType<typeof physical>['client'] | ReturnType<typeof createStableLogicalRpcClient>
) {
  const params = { repo: 'id:clone', number: 93, updates: { body: 'edit' } }
  const reply = await withGitHubTargetOperation({
    client,
    params,
    ownerRepo: repository,
    send: (selected, exact, options) =>
      githubIssueUpdate.request(selected, { ...params, ...exact }, options)
  })
  return githubIssueUpdate.interpret(reply)
}
it('executes stable exact targeting through the production operation and physical request tracker, releasing its listener', async () => {
  const a = physical('a')
  await expect(update(a.client)).resolves.toMatchObject({ ok: true })
  expect(a.writes).toMatchObject([
    {
      params: { ownerRepo: repository },
      envelope: { expectedRuntimeSource: { sourceId: 'a', runtimeId: 'a' } }
    }
  ])
  expect(a.client.stateListeners()).toBe(0)
})
it.each([false, true])(
  'refuses A after physical connect wait/migration to capable=%s B, then settles a fresh user attempt',
  async (capable) => {
    const a = physical('a'),
      b = physical('b', capable)
    const logical = createStableLogicalRpcClient(a.client, 'lan')
    a.pause()
    const pending = update(logical)
    const refused = expect(pending).rejects.toThrow()
    await a.reachedWait.promise
    await logical.migrateTo(b.client, 'relay')
    a.resume.resolve()
    await refused
    expect(a.writes).toEqual([])
    expect(b.writes).toEqual([])
    await (capable
      ? expect(update(logical)).resolves.toMatchObject({ ok: true })
      : expect(update(logical)).rejects.toThrow('Update Orca'))
    expect(b.writes).toHaveLength(capable ? 1 : 0)
    logical.close()
  }
)
it('a disconnect/reconnect cannot regain authority with an identical connected-at timestamp', async () => {
  const a = physical('a')
  a.pause()
  const pending = update(a.client)
  const refused = expect(pending).rejects.toThrow('connection changed')
  await a.reachedWait.promise
  a.client.pushState('disconnected')
  a.client.pushState('connected')
  a.resume.resolve()
  await refused
  expect(a.writes).toEqual([])
  expect(a.client.stateListeners()).toBe(0)
})
it.each([
  ['sends the ordinary update when its lookup lands on this issue', '1.4.247', 'fork', 1],
  ['refuses when its lookup lands on another repository', '1.4.247', 'upstream', 0],
  ['refuses before its writes followed its lookup', '1.4.220', 'fork', 0]
])('a server without exact targets %s', async (_name, appVersion, owner, sent) => {
  const frames: { method: string; params?: unknown; envelope?: unknown }[] = []
  const client = createFakeRpcClient()
  client.sendRequest = async (method, params, options) => {
    frames.push({ method, params, envelope: options?.envelope })
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'old',
            hostDescriptor: { installationId: 'old' },
            appVersion,
            capabilities: []
          }
        : method === 'github.workItem'
          ? {
              type: 'issue',
              number: 93,
              url: `https://github.corp/${owner}/widgets/issues/93`,
              labels: []
            }
          : { ok: true }
    return { id: String(frames.length), ok: true, result, _meta: { runtimeId: 'old' } }
  }
  const params = { repo: 'id:clone', number: 93, updates: { state: 'closed' as const } }
  const pending = withGitHubTargetOperation({
    client,
    params,
    ownerRepo: repository,
    issueTarget: { repository, type: 'issue', number: 93 },
    send: (selected, exact, options) =>
      githubIssueUpdate.request(selected, { ...params, ...exact }, options)
  })
  await (sent
    ? expect(pending).resolves.toBeDefined()
    : expect(pending).rejects.toThrow('Update Orca on the executing server'))
  expect(frames.filter((frame) => frame.method === 'github.updateIssue')).toEqual(
    sent ? [{ method: 'github.updateIssue', params, envelope: undefined }] : []
  )
})
it('names the relaying desktop when only it lacks the exact-target check', async () => {
  const desktop = physical('d', false),
    server = physical('s')
  const routed = {
    ...server.client,
    requestRoute: () => ({ client: server.client, intermediary: desktop.client })
  }
  await expect(update(routed)).rejects.toThrow(GITHUB_DESKTOP_UPDATE_REQUIRED)
  expect(server.writes).toEqual([])
})
