import { beforeEach, expect, it, vi } from 'vitest'

// Fresh modules per test: the shutdown flag and the serving milestone are process-wide.
async function loadModules() {
  const { mainProcessState: state } = await import('../main-process-state')
  const { markHostShuttingDown } = await import('../quit/host-shutdown-state')
  const { beginChatJournalStartup, chatJournalHostServing } = await import('./chat-journal-startup')
  return { state, markHostShuttingDown, beginChatJournalStartup, chatJournalHostServing }
}

function desktopStartup(state: Awaited<ReturnType<typeof loadModules>>['state']) {
  const fence = Promise.withResolvers<void>()
  state.firstWindowStartupServicesReady = fence.promise
  const opened: Promise<void>[] = []
  const runtime = {
    beginStructuredAgentSessionStartupOpen: (maintenanceAfter: Promise<void>) => {
      opened.push(maintenanceAfter)
    }
  }
  return { fence, opened, runtime }
}

beforeEach(() => {
  vi.resetModules()
})

it('opens saved chats on desktop once the first-window fence settles', async () => {
  const { state, beginChatJournalStartup } = await loadModules()
  const { fence, opened, runtime } = desktopStartup(state)

  beginChatJournalStartup(runtime, false)
  expect(opened).toHaveLength(0)
  fence.resolve()
  await vi.waitFor(() => expect(opened).toHaveLength(1))
})

it('does not open saved chats when the fence settles after shutdown committed', async () => {
  const { state, markHostShuttingDown, beginChatJournalStartup } = await loadModules()
  const { fence, opened, runtime } = desktopStartup(state)

  beginChatJournalStartup(runtime, false)
  markHostShuttingDown()
  fence.resolve()
  await fence.promise
  await new Promise((resolve) => setImmediate(resolve))

  expect(opened).toHaveLength(0)
})

it('admits CI-line watches on desktop only after the first-window fence settles', async () => {
  const { state, beginChatJournalStartup, chatJournalHostServing } = await loadModules()
  const { fence, runtime } = desktopStartup(state)
  const admitted: unknown[] = []
  const previous = state.runtime
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the serving milestone only calls startPullRequestWatches; the rest of the runtime is unused here.
  state.runtime = {
    startPullRequestWatches: (options?: unknown) => admitted.push(options)
  } as unknown as typeof state.runtime

  beginChatJournalStartup(runtime, false)
  chatJournalHostServing()
  await new Promise((resolve) => setImmediate(resolve))
  expect(admitted).toHaveLength(0)
  fence.resolve()
  await vi.waitFor(() => expect(admitted).toEqual([{ admit: true }]))
  state.runtime = previous
})
