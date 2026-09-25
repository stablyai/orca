import { expect, it } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'
import { closeBrowserClientHostComposition } from './paired-runtime-browser-client-host-teardown'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 3,
  pageCommandProtocolVersion: 1
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

function command(
  sequence: number,
  body: BrowserClientHostCommandEvent['command'],
  page = 'page-a'
): BrowserClientHostCommandEvent {
  return createCommand('createPage', {
    browserPageId: page,
    commandSequence: sequence,
    commandId: `${page}-${sequence}`,
    command: body
  })
}

async function rememberResult(
  dispatcher: BrowserClientHostCommandDispatcher,
  sequence: number
): Promise<WeakRef<object>> {
  const result = await dispatcher.dispatch(
    command(sequence, { type: 'automation', method: 'browser.snapshot', params: {} })
  )
  if (result.status !== 'completed' || typeof result.value !== 'object' || !result.value) {
    throw new Error('Expected an object result')
  }
  return new WeakRef(result.value)
}

function dispatchInput(
  dispatcher: BrowserClientHostCommandDispatcher,
  page: string
): { input: WeakRef<object>; result: Promise<BrowserClientHostCommandResult> } {
  const params = { title: `small-input-${page}` }
  return {
    input: new WeakRef(params),
    result: dispatcher.dispatch(
      command(2, { type: 'automation', method: 'browser.snapshot', params }, page)
    )
  }
}

it('releases completed results on close while preserving pending native page custody', async () => {
  const harness = createHarness()
  const navigation = deferred<boolean>()
  const entered = deferred<void>()
  let nativeSignal: AbortSignal | undefined
  let executorClosed = false
  let deferredClose: Promise<void> | undefined
  let ordinal = 0
  const executor = new BrowserClientPageCommandExecutor({
    ...harness.dependencies,
    executeAutomation: async () => ({ title: `small-result-${ordinal++}`, items: [1, 2, 3] }),
    routeWebContents: {
      ...harness.dependencies.routeWebContents,
      navigateGuest: () => {
        entered.resolve()
        return navigation.promise
      }
    }
  })
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    joinTimeoutMs: 15,
    handler: (event, signal) => {
      if (event.command.type === 'navigate') {
        nativeSignal = signal
      }
      return executor.handle(event, signal)
    }
  })
  await dispatcher.dispatch(createCommand('createPage'))
  const results: WeakRef<object>[] = []
  for (let sequence = 2; sequence < 34; sequence += 1) {
    results.push(await rememberResult(dispatcher, sequence))
  }
  await collect()
  expect(results.filter((result) => result.deref())).toHaveLength(32)
  const pending = dispatcher.dispatch(
    command(34, { type: 'navigate', url: 'https://example.invalid/held' })
  )
  await entered.promise
  executor.fenceNavigation()
  try {
    const settled = await closeBrowserClientHostComposition({
      host: {
        close: () => dispatcher.close(),
        whenHandlersSettled: () => dispatcher.whenClosed()
      },
      executor: {
        async close() {
          executorClosed = true
          await executor.close()
        }
      },
      routeSets: { close: async () => {} },
      error: new Error('controlled disconnect'),
      deferExecutorClose: (close) => {
        deferredClose = close
      },
      reportCleanupError: (error) => {
        throw error
      }
    })
    expect(settled).toBe(false)
    await expect(pending).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    expect(nativeSignal?.aborted).toBe(true)
    expect(executorClosed).toBe(false)
    expect(executor.hasPage('page-a', 7)).toBe(true)
    expect(harness.route.release).not.toHaveBeenCalled()
    expect(harness.routeSession.release).not.toHaveBeenCalled()
    expect(() => dispatcher.dispatch(createCommand('createPage'))).toThrow('dispatcher_closed')
    expect(await dispatcher.close()).toBe(false)
    await collect()
    expect(results.filter((result) => result.deref())).toHaveLength(0)
  } finally {
    navigation.resolve(true)
    await dispatcher.whenClosed()
    await deferredClose
    await executor.close()
  }
  expect(executorClosed).toBe(true)
  expect(harness.route.release).toHaveBeenCalledOnce()
  expect(harness.routeSession.release).toHaveBeenCalledOnce()
})

it('discards late closed records while retaining a sibling pending handler', async () => {
  const first = deferred<BrowserClientHostCommandResult>()
  const second = deferred<BrowserClientHostCommandResult>()
  const acceptedInputs = new Map<string, WeakRef<object>>()
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    joinTimeoutMs: 15,
    handler: (event) => {
      if (event.command.type === 'automation') {
        acceptedInputs.set(event.browserPageId, new WeakRef(event.command.params))
      }
      return event.command.type === 'createPage'
        ? { status: 'completed' }
        : event.browserPageId === 'page-a'
          ? first.promise
          : second.promise
    }
  })
  for (const page of ['page-a', 'page-b']) {
    await dispatcher.dispatch(
      command(
        1,
        { type: 'createPage', browserProfileId: 'profile-a', executionHostKey: 'execution-host-a' },
        page
      )
    )
  }
  const a = dispatchInput(dispatcher, 'page-a')
  const b = dispatchInput(dispatcher, 'page-b')
  try {
    expect(await dispatcher.close()).toBe(false)
    await expect(a.result).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    await expect(b.result).resolves.toMatchObject({ errorCode: 'browser_host_command_cancelled' })
    first.resolve({ status: 'completed' })
    await collect()
    expect(a.input.deref()).toBeUndefined()
    expect(b.input.deref()).toBeUndefined()
    expect(acceptedInputs.get('page-a')?.deref()).toBeUndefined()
    expect(acceptedInputs.get('page-b')?.deref()).toBeDefined()
    expect(await dispatcher.close()).toBe(false)
  } finally {
    first.resolve({ status: 'completed' })
    second.resolve({ status: 'completed' })
    await dispatcher.whenClosed()
  }
  await collect()
  expect(b.input.deref()).toBeUndefined()
  expect(acceptedInputs.get('page-b')?.deref()).toBeUndefined()
})
