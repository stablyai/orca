import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'
import { AutomationService } from './service'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import type { AutomationRunTerminalHost } from './runtime-terminal-run-observer'

const FINAL = 'CONFIG_STAMP: ORCA-HEALTH-2026-09-04-R14\nSTATUS: DONE'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  let run = {
    id: 'ad7d4a06-af46-4d55-ad59-0126cc32c1e1',
    automationId: 'health-watch',
    status: 'dispatching',
    reuseSession: false,
    workspaceId: 'folder:health',
    terminalSessionId: 'tab-health',
    terminalPaneKey: 'tab-health:11111111-2222-4333-8444-555555555555',
    terminalPtyId: 'term_1f32446b-e714-408e-af14-5b346d7e6e2d',
    outputSnapshot: null,
    usage: { status: 'unavailable' }
  } as AutomationRun
  const automation = { id: run.automationId, reuseSession: false } as Automation
  const published: AutomationRun[] = []
  const exit = deferred<Awaited<ReturnType<AutomationRunTerminalHost['waitForTerminal']>>>()
  const capture = deferred<{ tail: string[] }>()
  const runtime = {
    subscribeToPtyExit: vi.fn(() => () => {}),
    resolveTerminalPane: () => ({ handle: 'terminal-health', ptyId: run.terminalPtyId }),
    // A startup-only done is already present; the process has not exited.
    waitForTerminal: vi.fn((_handle, options) =>
      options?.condition === 'exit' ? exit.promise : Promise.resolve({ satisfied: true })
    ),
    readTerminal: vi.fn(() => capture.promise)
  } satisfies AutomationRunTerminalHost
  const store = {
    listAutomations: () => [automation],
    listAutomationRuns: () => [run],
    updateAutomationRun: (result: AutomationDispatchResult) => {
      run = { ...run, ...result }
      return run
    },
    automationChangeSelector: () => ({ kind: 'self' })
  } as unknown as Store
  const service = new AutomationService(store, {
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
    onAutomationsChanged: () => published.push(structuredClone(run))
  })
  return { service, runtime, exit, capture, published, automation, run: () => run }
}

describe('automation final settlement (ROB-1925)', () => {
  it('rejects startup completion while live and publishes final capture with cleared identity', async () => {
    const f = fixture()
    try {
      await f.service.markDispatchResult({ runId: f.run().id, status: 'dispatched' })
      await f.service.markDispatchResult({
        runId: f.run().id,
        status: 'completed',
        outputSnapshot: {
          format: 'plain_text',
          content: 'echoed prompt fragments',
          capturedAt: 5_000,
          truncated: false
        }
      })
      expect(f.run().status).toBe('dispatched')
      expect(f.published.some((run) => run.status === 'completed')).toBe(false)
      expect(f.runtime.readTerminal).not.toHaveBeenCalled()

      f.exit.resolve({ satisfied: true, exitCode: 0 })
      await vi.waitFor(() => expect(f.runtime.readTerminal).toHaveBeenCalledOnce())
      expect(f.run().status).toBe('dispatched')
      f.capture.resolve({ tail: [FINAL] })
      await vi.waitFor(() => expect(f.run().status).toBe('completed'))
      expect(f.run()).toMatchObject({
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null,
        outputSnapshot: { content: FINAL, truncated: false }
      })
      expect(f.published.filter((run) => run.status === 'completed')).toEqual([f.run()])
      // A delayed old-client completion must not replace the authoritative final.
      await f.service.markDispatchResult({
        runId: f.run().id,
        status: 'completed',
        outputSnapshot: null
      })
      expect(f.run().outputSnapshot?.content).toBe(FINAL)
    } finally {
      f.service.stop()
    }
  })

  it('does not weaken the active run exit fence when session reuse is enabled later', async () => {
    const f = fixture()
    try {
      await f.service.markDispatchResult({ runId: f.run().id, status: 'dispatched' })
      f.automation.reuseSession = true
      await f.service.markDispatchResult({ runId: f.run().id, status: 'completed' })
      expect(f.run().status).toBe('dispatched')
    } finally {
      f.service.stop()
    }
  })

  it('does not publish a capture that resolves after the watcher is stopped', async () => {
    const f = fixture()
    await f.service.markDispatchResult({ runId: f.run().id, status: 'dispatched' })
    f.exit.resolve({ satisfied: true, exitCode: 0 })
    await vi.waitFor(() => expect(f.runtime.readTerminal).toHaveBeenCalledOnce())
    f.service.stop()
    f.capture.resolve({ tail: [FINAL] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.run().status).toBe('dispatched')
    expect(f.published.some((run) => run.status === 'completed')).toBe(false)
  })

  it.each([-1, undefined])(
    'does not interpret remote exit code %s as success',
    async (exitCode) => {
      const f = fixture()
      try {
        await f.service.markDispatchResult({ runId: f.run().id, status: 'dispatched' })
        f.exit.resolve({ satisfied: true, exitCode })
        f.capture.resolve({ tail: ['partial work'] })
        await vi.waitFor(() => expect(f.run().status).toBe('dispatch_failed'))
        expect(f.run().error).not.toMatch(/exited with code/)
        expect(f.published.some((run) => run.status === 'completed')).toBe(false)
        expect(f.run().terminalPtyId).not.toBeNull()
      } finally {
        f.service.stop()
      }
    }
  )

  it('cannot complete when the final capture fails after proven exit', async () => {
    const f = fixture()
    try {
      await f.service.markDispatchResult({ runId: f.run().id, status: 'dispatched' })
      f.exit.resolve({ satisfied: true, exitCode: 0 })
      await vi.waitFor(() => expect(f.runtime.readTerminal).toHaveBeenCalledOnce())
      f.capture.reject(new Error('remote capture unavailable'))
      await vi.waitFor(() => expect(f.run().status).toBe('dispatch_failed'))
      expect(f.published.some((run) => run.status === 'completed')).toBe(false)
    } finally {
      f.service.stop()
    }
  })
})
