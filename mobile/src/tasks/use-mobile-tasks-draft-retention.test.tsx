import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { ConnectionState } from '../transport/types'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import { item } from './github-task-identity.test-fixture'
import { useMobileTasksSelection } from './github-task-identity'
import { useMobileTasksItemState } from './use-mobile-tasks-item-state'
import { useMobileTasksRuntimeHydration } from './use-mobile-tasks-runtime-hydration'
import { useMobileTasksItemSelectionEffects } from './use-mobile-tasks-list-and-detail-effects'

vi.mock('./mobile-tasks-dependencies', async () => ({ ...(await import('react')) }))
vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  ...(await import('./mobile-tasks-item-comments'))
}))
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))

const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount())
  }
})

async function mountTasks() {
  const client = createFakeRpcClient()
  const commands = {
    connect: (_state: ConnectionState): void => {},
    select: (_item: ActionableTaskItem | null): void => {},
    typeComment: (_text: string): void => {},
    openCreate: (): void => {}
  }
  const seen: { actionItem: ActionableTaskItem | null; comment: string } = {
    actionItem: null,
    comment: ''
  }
  let showCreateTask = false
  function Probe(): null {
    const [connState, setConnState] = useState<ConnectionState>('connected')
    const [createSheetOpen, setShowCreateTask] = useState(false)
    const itemState = useMobileTasksItemState()
    const selection = useMobileTasksSelection(client, itemState.readDetailPayload, () => {})
    const owned: Record<string, unknown> = {
      client,
      connState,
      requestedTaskSource: undefined,
      provider: 'github',
      visibleProviders: ['github'],
      taskResumeRef: { current: {} },
      jiraStatusRequestIdRef: { current: 0 },
      defaultLinearTeamSelectionRef: { current: null },
      resetWorkspaceCreateState: () => {},
      setActionItem: selection.setActionItem,
      setShowCreateTask
    }
    // Setters this test doesn't observe are no-ops.
    const model = new Proxy(owned, {
      get: (target, key) => (typeof key === 'string' && key in target ? target[key] : () => {})
    })
    useMobileTasksRuntimeHydration(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy supplies every setter the hydration effect calls before its first reply.
      model as unknown as Parameters<typeof useMobileTasksRuntimeHydration>[0]
    )
    useMobileTasksItemSelectionEffects({ ...itemState, ...selection, client })
    commands.connect = setConnState
    commands.select = selection.setActionItem
    commands.typeComment = itemState.setItemCommentDraft
    commands.openCreate = () => setShowCreateTask(true)
    seen.actionItem = selection.actionItem
    seen.comment = itemState.itemCommentDraft
    showCreateTask = createSheetOpen
    return null
  }
  await act(async () => {
    renderers.push(create(createElement(Probe)))
  })
  const run = (command: () => void) => act(async () => command())
  return {
    seen,
    showCreateTask: () => showCreateTask,
    connect: (state: ConnectionState) => run(() => commands.connect(state)),
    select: (next: ActionableTaskItem | null) => run(() => commands.select(next)),
    typeComment: (text: string) => run(() => commands.typeComment(text)),
    openCreate: () => run(() => commands.openCreate())
  }
}

it('keeps the open item, its comment draft and the create sheet across a reconnect', async () => {
  const tasks = await mountTasks()
  await tasks.select(item('acme'))
  await tasks.typeComment('Looks good, one nit')
  await tasks.openCreate()

  await tasks.connect('reconnecting')
  await tasks.connect('connected')

  expect(tasks.seen.actionItem?.key).toBe('acme')
  expect(tasks.seen.comment).toBe('Looks good, one nit')
  expect(tasks.showCreateTask()).toBe(true)
})

it('keeps the comment draft when the same item arrives as a new object', async () => {
  const tasks = await mountTasks()
  const opened = item('acme')
  await tasks.select(opened)
  await tasks.typeComment('Looks good, one nit')

  await tasks.select({ ...opened, status: 'Closed' })
  expect(tasks.seen.comment).toBe('Looks good, one nit')

  await tasks.select(item('other'))
  expect(tasks.seen.comment).toBe('')
})
