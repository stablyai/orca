import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { pluginChatServices } from './plugin-chat-services'
import { bindPluginHostServices } from './plugin-host-service-bindings'
import { executePluginHostCall } from './plugin-host-methods'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  await rig.host.showSessionTabs([SESSION])
})
afterEach(() => rig.dispose())

it('scopes reads and mutations to an explicit local chat in the workspace', async () => {
  const services = pluginChatServices(() => rig.host)
  const workspace = rig.store.getRecord(SESSION)!.location.workspaceId
  expect(await services.list(workspace)).toEqual([{ sessionId: SESSION, agent: 'codex' }])
  await expect(services.read('other-workspace', SESSION)).rejects.toThrow('outside')
  const read = await services.read(workspace, SESSION)
  await expect(
    services.handoff('other-workspace', 'samples.handoff', {
      sessionId: SESSION,
      operationId: 'handoff-1',
      fence: read.fence,
      cursor: read.cursor,
      context: 'Do not lose the latest message'
    })
  ).rejects.toThrow('outside')
  expect(rig.closeSession).not.toHaveBeenCalled()
})

it('reads exact user text and refuses a summary if another message arrived', async () => {
  const services = pluginChatServices(() => rig.host)
  const workspace = rig.store.getRecord(SESSION)!.location.workspaceId
  const first = rig.send('Exact  text\nwith newline')
  await first.result
  await rig.settleAccepted(first.id, 'answer')
  const read = await services.read(workspace, SESSION)
  expect(read.latestUserMessage).toBe('Exact  text\nwith newline')
  await rig.send('A new instruction').result
  expect(
    await services.handoff(workspace, 'samples.handoff', {
      sessionId: SESSION,
      operationId: 'handoff-1',
      fence: read.fence,
      cursor: read.cursor,
      context: 'Prepared before the latest instruction'
    })
  ).toMatchObject({ completed: false })
  expect(rig.closeSession).not.toHaveBeenCalled()
})

it('requires handoff permission and a worker before calling the service', async () => {
  const handoff = vi.fn()
  const services = bindPluginHostServices({
    pluginsDataDir: rig.root,
    delegate: {
      resolveActiveWorktreeContext: async () => ({
        worktreeId: 'w',
        path: '/w',
        branch: 'main',
        displayName: 'w'
      }),
      listTerminals: async () => ({ terminals: [] }),
      sendTerminal: async () => ({ accepted: true }),
      dispatchPluginNotification: async () => ({ delivered: true })
    }
  })
  services.chats = { list: vi.fn(), read: vi.fn(), handoff }
  const input = {
    pluginId: 'samples.handoff',
    method: 'chat.handoff',
    params: {
      sessionId: SESSION,
      operationId: 'h',
      fence: 1,
      cursor: { epoch: 'e', sequence: 0 },
      context: 'summary'
    },
    services,
    audit: { record: vi.fn() }
  }
  expect(
    await executePluginHostCall({
      ...input,
      surface: 'worker',
      grantedCapabilities: ['chat:read']
    })
  ).toMatchObject({ ok: false })
  expect(
    await executePluginHostCall({
      ...input,
      surface: 'panel',
      grantedCapabilities: ['chat:handoff']
    })
  ).toMatchObject({ ok: false })
  expect(handoff).not.toHaveBeenCalled()
})

it('includes the previous handoff when preparing the next summary', async () => {
  const services = pluginChatServices(() => rig.host)
  const workspace = rig.store.getRecord(SESSION)!.location.workspaceId
  const first = rig.send('Keep the original requirement')
  await first.result
  await rig.settleAccepted(first.id, 'answer')
  const read = await services.read(workspace, SESSION)
  expect(
    await services.handoff(workspace, 'samples.handoff', {
      sessionId: SESSION,
      operationId: hostTestOperationId(),
      fence: read.fence,
      cursor: read.cursor,
      context: 'The original requirement remains important'
    })
  ).toEqual({ completed: true })
  expect((await services.read(workspace, SESSION)).transcript).toContain(
    'The original requirement remains important'
  )
})
