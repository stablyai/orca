import { afterEach, expect, it, vi } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { loadSources } = createRequire(import.meta.url)('./sources.cjs')
const sourceInfo = loadSources()
import { BrowserClientHostCommandDispatcher } from '../../../src/main/browser/browser-client-host-command-dispatcher'
import {
  createHarness,
  createCommand
} from '../../../src/main/browser/browser-client-page-command-executor-test-harness'
import { BrowserClientPageAutomationRuntime } from '../../../src/main/browser/browser-client-page-automation-runtime'
import { navigateBrowserRouteGuest } from '../../../src/main/browser/browser-route-guest-lifecycle'
import { closeBrowserClientHostComposition } from '../../../src/main/browser/paired-runtime-browser-client-host-teardown'
import { BROWSER_CORE_METHODS } from '../../../src/main/runtime/rpc/methods/browser-core'

const fixed = process.env.ORCA_BROWSER_CACHE_VARIANT !== 'before'
const variant = fixed ? 'fixed' : 'before',
  reports = []
const authority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 3,
  pageCommandProtocolVersion: 1
}
function gate() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function collect() {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise(setImmediate)
    global.gc()
  }
}
function alive(refs) {
  return refs.filter((ref) => ref.deref()).length
}
function command(sequence, body, page = 'page-a', generation = 7) {
  return createCommand('createPage', {
    browserPageId: page,
    pageHostGeneration: generation,
    commandSequence: sequence,
    commandId: `${page}-${generation}-${sequence}`,
    command: body
  })
}
function cached(dispatcher) {
  return [...dispatcher.pages.values()].reduce((sum, page) => sum + page.settledSequences.length, 0)
}
function queueUnstartedPayload(dispatcher) {
  const payload = { queued: 'small-command-input' }
  return {
    ref: new WeakRef(payload),
    promise: dispatcher.dispatch(
      command(35, { type: 'automation', method: 'browser.snapshot', params: { payload } })
    )
  }
}
async function appendSnapshot(dispatcher, index) {
  const result = await dispatcher.dispatch(
    command(index + 2, { type: 'automation', method: 'browser.snapshot', params: {} })
  )
  expect(result.status).toBe('completed')
  return new WeakRef(result.value)
}
afterEach(() => {
  vi.restoreAllMocks()
  writeFileSync(
    process.env.ORCA_BROWSER_CACHE_OUTPUT ??
      `docs/audits/browser-closed-result-retention/${variant}-${process.versions.electron ? 'electron' : 'node'}-results.json`,
    `${JSON.stringify(
      {
        sources: sourceInfo.hashes,
        runtime: {
          node: process.versions.node,
          electron: process.versions.electron ?? null,
          v8: process.versions.v8
        },
        variant,
        cases: reports
      },
      null,
      2
    )}\n`
  )
})

it('keeps completed actual automation results behind one pending native navigation after close timeout', async () => {
  const h = createHarness(),
    native = gate(),
    entered = gate()
  let signal,
    ordinal = 0,
    executorClosed = false,
    deferredClose
  const snapshot = BROWSER_CORE_METHODS.find((method) => method.name === 'browser.snapshot')
  const automation = new BrowserClientPageAutomationRuntime({
    browserManager: {
      getGuestWebContentsId: () => 41,
      registerGuest: () => true,
      unregisterGuest() {}
    },
    getAgentBrowserBridge: () => null,
    executeRpc: (_method, params, contextSignal) =>
      snapshot.handler(params, {
        signal: contextSignal,
        runtime: {
          browserSnapshot: async () => ({ title: `ordinary-result-${ordinal++}`, items: [1, 2, 3] })
        }
      })
  })
  h.dependencies.executeAutomation = (input, contextSignal) =>
    automation.execute(input, contextSignal)
  h.dependencies.retireAutomation = (input) => automation.retire(input)
  h.dependencies.routeWebContents.navigateGuest = (claim, url) =>
    navigateBrowserRouteGuest(
      claim.registration,
      url,
      {
        registration: claim.registration,
        navigationGranted: true,
        guest: {
          loadURL: () => {
            entered.resolve()
            return native.promise
          }
        }
      },
      () => true
    )
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    handler: (event, contextSignal) => {
      if (event.command.type === 'navigate') {
        signal = contextSignal
      }
      return h.executor.handle(event, contextSignal)
    },
    joinTimeoutMs: 15
  })
  await dispatcher.dispatch(createCommand('createPage'))
  const refs = []
  for (let index = 0; index < 32; index++) {
    refs.push(await appendSnapshot(dispatcher, index))
  }
  await collect()
  expect(alive(refs)).toBe(32)
  const pending = dispatcher.dispatch(
    command(34, { type: 'navigate', url: 'https://example.invalid/held' })
  )
  await entered.promise
  const queued = queueUnstartedPayload(dispatcher)
  h.executor.fenceNavigation()
  const closing = closeBrowserClientHostComposition({
    host: { close: () => dispatcher.close(), whenHandlersSettled: () => dispatcher.whenClosed() },
    executor: {
      async close() {
        executorClosed = true
        await h.executor.close()
      }
    },
    routeSets: { async close() {} },
    error: new Error('controlled disconnect'),
    deferExecutorClose: (close) => {
      deferredClose = close
    },
    reportCleanupError: (error) => {
      throw error
    }
  })
  try {
    expect(await closing).toBe(false)
    expect(await pending).toMatchObject({
      status: 'failed',
      errorCode: 'browser_host_command_cancelled'
    })
    expect(await queued.promise).toMatchObject({
      status: 'failed',
      errorCode: 'browser_host_command_cancelled'
    })
    expect(signal.aborted).toBe(true)
    expect(executorClosed).toBe(false)
    expect(h.executor.hasPage('page-a', 7)).toBe(true)
    expect(h.route.release).not.toHaveBeenCalled()
    expect(h.routeSession.release).not.toHaveBeenCalled()
    expect(() => dispatcher.dispatch(createCommand('createPage'))).toThrow('dispatcher_closed')
    expect(await dispatcher.close()).toBe(false)
    let settled = false
    void dispatcher.whenClosed().then(() => {
      settled = true
    })
    await collect()
    expect(settled).toBe(false)
    const retained = alive(refs),
      cachedResults = cached(dispatcher)
    expect(retained).toBe(fixed ? 0 : 32)
    expect(cachedResults).toBe(fixed ? 0 : 34)
    expect(Boolean(queued.ref.deref())).toBe(!fixed)
    expect(dispatcher.runningHandlers).toBe(1)
    reports.push({
      kind: 'native-navigation-close',
      completedPayloads: 32,
      heldNativePorts: 1,
      joinTimeoutOverrideMs: 15,
      retainedPayloadsAfterClose: retained,
      cachedResultsAfterClose: cachedResults,
      cancelledQueuedInputRetained: Boolean(queued.ref.deref()),
      signalAborted: true,
      executorCustodyPreserved: true,
      routeLeasePreserved: true,
      closedDuplicateRejected: true,
      secondCloseSettled: false
    })
  } finally {
    native.resolve()
    await dispatcher.whenClosed()
    await deferredClose
    await h.executor.close()
  }
  await collect()
  expect(alive(refs)).toBe(0)
  expect(executorClosed).toBe(true)
  expect(h.route.release).toHaveBeenCalledOnce()
  expect(h.routeSession.release).toHaveBeenCalledOnce()
  reports.at(-1).retainedAfterNativeSettlement = alive(refs)
  reports.at(-1).executorClosedAfterNativeSettlement = true
})

it('does not retain late completed cancellation records while a sibling native handler remains owned', async () => {
  const first = gate(),
    second = gate()
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    joinTimeoutMs: 15,
    handler: (event) => (event.browserPageId === 'page-a' ? first.promise : second.promise)
  })
  const firstResult = dispatcher.dispatch(
    command(
      1,
      { type: 'createPage', browserProfileId: 'profile-a', executionHostKey: 'execution-host-a' },
      'page-a'
    )
  )
  const secondResult = dispatcher.dispatch(
    command(
      1,
      { type: 'createPage', browserProfileId: 'profile-a', executionHostKey: 'execution-host-a' },
      'page-b'
    )
  )
  expect(await dispatcher.close()).toBe(false)
  expect(await firstResult).toMatchObject({ errorCode: 'browser_host_command_cancelled' })
  expect(await secondResult).toMatchObject({ errorCode: 'browser_host_command_cancelled' })
  first.resolve({ status: 'completed', value: { late: 'ignored' } })
  await new Promise(setImmediate)
  expect(dispatcher.runningHandlers).toBe(1)
  expect(cached(dispatcher)).toBe(fixed ? 0 : 1)
  expect(dispatcher.pages.get('page-a').records.size).toBe(fixed ? 0 : 1)
  let settled = false
  void dispatcher.whenClosed().then(() => {
    settled = true
  })
  await new Promise(setImmediate)
  expect(settled).toBe(false)
  reports.push({
    kind: 'late-sibling-settlement',
    oneHandlerStillOwned: true,
    cachedAfterFirstSettlement: cached(dispatcher),
    closedSettlementStillPending: true
  })
  second.reject(new Error('controlled native failure'))
  await dispatcher.whenClosed()
  expect(dispatcher.runningHandlers).toBe(0)
  expect(dispatcher.pages.size).toBe(0)
})

it('preserves open replay and generation fencing independently of closed cache release', async () => {
  let calls = 0
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    handler: () => {
      calls++
      return { status: 'completed', value: { ordinary: true } }
    }
  })
  const event = command(1, {
    type: 'createPage',
    browserProfileId: 'profile-a',
    executionHostKey: 'execution-host-a'
  })
  const original = dispatcher.dispatch(event),
    duplicate = dispatcher.dispatch(event)
  expect(duplicate).toBe(original)
  await original
  expect(dispatcher.dispatch(event)).toBe(original)
  expect(calls).toBe(1)
  expect(await dispatcher.retirePage('page-a', 7)).toBe(true)
  expect(() => dispatcher.dispatch(event)).toThrow('generation_stale')
  expect(cached(dispatcher)).toBe(1)
  expect(dispatcher.forgetPage('page-a', 7)).toBe(true)
  expect(cached(dispatcher)).toBe(0)
  expect(() => dispatcher.dispatch(event)).toThrow('generation_stale')
  expect(await dispatcher.close()).toBe(true)
  reports.push({
    kind: 'open-replay-and-retire-contract',
    openPromiseIdentityPreserved: true,
    retiredDuplicateRejected: true,
    retireCachePolicyUnchanged: true,
    explicitForgetReleasedCache: true
  })
})

it('loads identical canonical hashes from synthetic CRLF source and patch reads', () => {
  let reads = 0
  const crlf = loadSources({
    readText: (filename) => {
      reads++
      return readFileSync(filename, 'utf8').replace(/\r?\n/g, '\r\n')
    }
  })
  expect(crlf.hashes).toEqual(sourceInfo.hashes)
  expect([...crlf.before.entries()]).toEqual([...sourceInfo.before.entries()])
  expect([...crlf.after.entries()]).toEqual([...sourceInfo.after.entries()])
  reports.push({ kind: 'synthetic-crlf-source-control', canonicalHashesMatch: true, reads })
})
