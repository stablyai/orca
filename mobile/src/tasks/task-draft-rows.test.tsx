import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { resetDurableDraftFieldsForTests } from '../drafts/durable-draft-fields'
import { publishInMemoryDeviceStore } from '../drafts/in-memory-device-store.test-support'
import { item } from './github-task-identity.test-fixture'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import { useTaskCommentDraft, useTaskCreateDraft } from './task-draft-rows'

type Screen = {
  comment: ReturnType<typeof useTaskCommentDraft>
  create: ReturnType<typeof useTaskCreateDraft>
}

// The shell's draft table outlives the page; nothing else does.
const table = new Map<string, string>()
let renderer: ReactTestRenderer | null = null
let screen: Screen | null = null

function Tasks(props: { item: ActionableTaskItem | null }) {
  screen = { comment: useTaskCommentDraft(props.item), create: useTaskCreateDraft() }
  return null
}

async function open(selected: ActionableTaskItem | null): Promise<Screen> {
  await act(async () => {
    if (renderer) {
      renderer.update(createElement(Tasks, { item: selected }))
    } else {
      renderer = create(createElement(Tasks, { item: selected }))
    }
    await vi.advanceTimersByTimeAsync(0)
  })
  return screen!
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

// A kill: the page and its memory go, the store stays.
function kill(): void {
  act(() => renderer?.unmount())
  renderer = null
  resetDurableDraftFieldsForTests()
}

beforeEach(() => {
  vi.useFakeTimers()
  publishInMemoryDeviceStore(table)
})

afterEach(() => {
  kill()
  table.clear()
  publishPageDeviceStore(null)
  vi.useRealTimers()
})

it('brings a comment back to the item it was typed on after a kill', async () => {
  const typed = await open(item('acme'))
  act(() => typed.comment[1]('Looks good, one nit'))
  await settle()
  kill()

  expect((await open(item('other'))).comment[0]).toBe('')
  expect((await open(item('acme'))).comment[0]).toBe('Looks good, one nit')
})

it('does not bring back a comment whose send landed after the user moved on', async () => {
  const typed = await open(item('acme'))
  act(() => typed.comment[1]('Looks good, one nit'))
  await settle()
  const clearSent = typed.comment[1]

  await open(item('other'))
  act(() => clearSent((current) => (current.trim() === 'Looks good, one nit' ? '' : current)))
  await settle()
  kill()

  expect((await open(item('acme'))).comment[0]).toBe('')
})

it('brings the New issue title and body back after a kill', async () => {
  const typed = await open(null)
  act(() => {
    typed.create.setCreateTitle('Crash on launch')
    typed.create.setCreateBody('Steps: open the app')
  })
  await settle()
  kill()

  const reopened = await open(null)
  expect(reopened.create.createTitle).toBe('Crash on launch')
  expect(reopened.create.createBody).toBe('Steps: open the app')
})
