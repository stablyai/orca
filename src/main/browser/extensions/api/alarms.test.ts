import { afterEach, expect, it, vi } from 'vitest'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The alarm fixture supplies the caller fields and session identity used by the production path.
const events = vi.hoisted(() => [] as unknown[][])
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (...args: unknown[]) => {
    events.push(args)
  }
}))
vi.mock('electron', () => ({ webFrameMain: {} }))
import { ensureHostSessionState } from '../api-runtime/browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from '../api-runtime/browser-extension-execution-authority'
import {
  getBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { registerAlarmsNamespace, resumeBrowserExtensionAlarms } from './alarms'
registerAlarmsNamespace()
afterEach(() => {
  vi.useRealTimers()
  events.length = 0
})

it('keeps alarms inert without an execution and resumes an overdue periodic alarm once with its state intact', async () => {
  vi.useFakeTimers({ now: 1_000_000 })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The alarm fixture supplies the caller fields and session identity used by the production path.
  const session = {} as Electron.Session
  ensureHostSessionState(session, 'work')
  const execution = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The alarm fixture supplies the caller fields and session identity used by the production path.
  const caller = {
    session,
    extension: { id: 'vault' },
    browserProfileId: 'work',
    execution
  } as BrowserExtensionCaller
  const api = getBrowserExtensionNamespace('alarms')!.methods
  await api.create.invoke(caller, ['saved', { delayInMinutes: 1, periodInMinutes: 1 }])
  resumeBrowserExtensionAlarms(session, 'vault')
  await retireBrowserExtensionExecution(session, 'vault')
  await vi.advanceTimersByTimeAsync(180_000)
  expect(events).toEqual([])
  const next = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
  resumeBrowserExtensionAlarms(session, 'vault')
  await vi.advanceTimersByTimeAsync(0)
  expect(events.map((event) => event.slice(1))).toEqual([
    [
      'alarms',
      'onAlarm',
      [{ name: 'saved', scheduledTime: 1_060_000, periodInMinutes: 1, persistAcrossSessions: true }]
    ]
  ])
  expect(await api.get.invoke({ ...caller, execution: next }, ['saved'])).toEqual({
    name: 'saved',
    scheduledTime: 1_240_000,
    periodInMinutes: 1,
    persistAcrossSessions: true
  })
  await retireBrowserExtensionExecution(session, 'vault')
})
