import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-conversation-preferences-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function dispatcherFor(store: ReturnType<typeof createStore>) {
  return new RpcDispatcher({
    runtime: new OrcaRuntimeService(store),
    methods: CLIENT_UI_METHODS
  })
}

it('merges concurrent host-qualified conversation changes through RPC and persists restore across restart', async () => {
  const store = createStore()
  const dispatcher = dispatcherFor(store)
  const remote = JSON.stringify(['ssh:alpha', 'structured', 'same-session'])
  const local = JSON.stringify(['local', 'structured', 'same-session'])
  const mutate = (id: string, params: unknown) =>
    dispatcher.dispatch({ id, authToken: 'tok', method: 'ui.setConversationPreference', params })

  const responses = await Promise.all([
    mutate('pin-remote', { key: remote, pinned: true }),
    mutate('archive-remote', { key: remote, archived: true }),
    mutate('pin-local', { key: local, pinned: true })
  ])
  expect(responses).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true })
  ])
  expect(store.getUI().conversationPreferences).toEqual({
    revision: 3,
    entries: { [remote]: { pinned: true, archived: true }, [local]: { pinned: true } }
  })

  expect(await mutate('restore-remote', { key: remote, archived: false })).toMatchObject({
    ok: true,
    result: { preferences: { revision: 4 } }
  })
  expect(
    await dispatcher.dispatch({
      id: 'resize',
      authToken: 'tok',
      method: 'ui.set',
      params: { sidebarWidth: 280 }
    })
  ).toMatchObject({ ok: true })
  store.flush()
  await closeTestStores()

  const reopened = createStore()
  expect(reopened.getUI()).toMatchObject({
    sidebarWidth: 280,
    conversationPreferences: {
      revision: 4,
      entries: { [remote]: { pinned: true, archived: false }, [local]: { pinned: true } }
    }
  })
})

it('persists hidden discovered groups and restores them without touching project files or history', async () => {
  const file = join(testState.dir, 'project-file.txt')
  const history = join(testState.dir, 'transcript.jsonl')
  writeFileSync(file, 'keep project contents')
  writeFileSync(history, 'keep conversation contents')
  const key = JSON.stringify(['runtime:remote', 'folder:/notes'])
  let store = createStore()
  const mutate = (hidden: boolean) =>
    dispatcherFor(store).dispatch({
      id: hidden ? 'hide' : 'restore',
      authToken: 'tok',
      method: 'ui.setConversationPreference',
      params: { projectKey: key, label: 'Notes', hidden }
    })
  expect(await mutate(true)).toMatchObject({ ok: true })
  store.flush()
  await closeTestStores()
  store = createStore()
  expect(store.getUI().conversationPreferences?.hiddenProjects).toEqual({ [key]: 'Notes' })
  expect(await mutate(false)).toMatchObject({ ok: true })
  store.flush()
  await closeTestStores()
  expect(createStore().getUI().conversationPreferences?.hiddenProjects).toEqual({})
  expect(readFileSync(file, 'utf8')).toBe('keep project contents')
  expect(readFileSync(history, 'utf8')).toBe('keep conversation contents')
})
