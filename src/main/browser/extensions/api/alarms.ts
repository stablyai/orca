import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import {
  getBrowserExtensionExecution,
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from '../api-runtime/browser-extension-execution-authority'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'

type Alarm = {
  name: string
  scheduledTime: number
  periodInMinutes?: number
  persistAcrossSessions: boolean
}
type AlarmState = {
  alarms: Map<string, Alarm>
  execution?: BrowserExtensionExecution
  timer?: NodeJS.Timeout
  lastPoll: number
}
const sessions = new WeakMap<Electron.Session, Map<string, AlarmState>>()

function stateFor(session: Electron.Session, extensionId: string): AlarmState {
  let extensions = sessions.get(session)
  if (!extensions) {
    extensions = new Map()
    sessions.set(session, extensions)
  }
  let state = extensions.get(extensionId)
  if (!state) {
    state = { alarms: new Map(), lastPoll: 0 }
    extensions.set(extensionId, state)
  }
  return state
}

function schedule(state: AlarmState): void {
  clearTimeout(state.timer)
  state.timer = undefined
  const execution = state.execution
  if (!execution || !isBrowserExtensionExecutionLive(execution) || state.alarms.size === 0) {
    return
  }
  const next = Math.min(...[...state.alarms.values()].map((alarm) => alarm.scheduledTime))
  // Electron loads all packages as unpacked: the native minimum polling interval is one second.
  const delay = Math.max(0, Math.max(next, state.lastPoll + 1000) - Date.now())
  state.timer = setTimeout(
    () => {
      state.timer = undefined
      if (state.execution !== execution || !isBrowserExtensionExecutionLive(execution)) {
        return
      }
      const now = Date.now()
      state.lastPoll = now
      for (const [name, alarm] of state.alarms) {
        if (alarm.scheduledTime > now) {
          continue
        }
        const fired = { ...alarm }
        if (alarm.periodInMinutes === undefined) {
          state.alarms.delete(name)
        } else {
          const period = alarm.periodInMinutes * 60_000
          alarm.scheduledTime =
            period > 0
              ? alarm.scheduledTime +
                period * (Math.floor((now - alarm.scheduledTime) / period) + 1)
              : now
        }
        emitBrowserExtensionEvent(
          { session: execution.session, extensionId: execution.extensionId },
          'alarms',
          'onAlarm',
          [fired]
        )
      }
      schedule(state)
    },
    Math.min(delay, 2_147_483_647)
  )
  state.timer.unref()
}

/** Readiness restores listeners before an overdue alarm can wake the current worker. */
export function resumeBrowserExtensionAlarms(session: Electron.Session, extensionId: string): void {
  const state = stateFor(session, extensionId)
  const execution = getBrowserExtensionExecution(session, extensionId)
  if (!execution || state.execution === execution) {
    return
  }
  state.execution = execution
  state.lastPoll = 0
  execution.controller.signal.addEventListener(
    'abort',
    () => {
      if (state.execution !== execution) {
        return
      }
      clearTimeout(state.timer)
      state.timer = undefined
      state.execution = undefined
    },
    { once: true }
  )
  schedule(state)
}

export function forgetBrowserExtensionAlarms(session: Electron.Session, extensionId: string): void {
  const state = sessions.get(session)?.get(extensionId)
  clearTimeout(state?.timer)
  sessions.get(session)?.delete(extensionId)
}

const infoSchema = z.object({
  when: z.number().finite().optional(),
  delayInMinutes: z.number().finite().nonnegative().optional(),
  periodInMinutes: z.number().finite().nonnegative().optional(),
  persistAcrossSessions: z.boolean().optional()
})
function create(
  caller: BrowserExtensionCaller,
  name: string,
  info: z.infer<typeof infoSchema>
): void {
  name = name.toWellFormed()
  const nameBytes = Buffer.byteLength(name)
  if (nameBytes > 1024) {
    throw new BrowserExtensionApiError(
      `Alarm name size is ${nameBytes} bytes which exceeds the limit of 1024 bytes.`
    )
  }
  if (info.when !== undefined && info.delayInMinutes !== undefined) {
    throw new BrowserExtensionApiError('Cannot set both when and delayInMinutes.')
  }
  if (
    info.when === undefined &&
    info.delayInMinutes === undefined &&
    info.periodInMinutes === undefined
  ) {
    throw new BrowserExtensionApiError(
      'Must set at least one of when, delayInMinutes, or periodInMinutes.'
    )
  }
  const state = stateFor(caller.session, caller.extension.id)
  if (state.alarms.size >= 500) {
    throw new BrowserExtensionApiError('An extension cannot have more than 500 active alarms.')
  }
  state.alarms.set(name, {
    name,
    scheduledTime:
      info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
    ...(info.periodInMinutes !== undefined ? { periodInMinutes: info.periodInMinutes } : {}),
    persistAcrossSessions: info.persistAcrossSessions ?? true
  })
  schedule(state)
}

export function registerAlarmsNamespace(): void {
  registerBrowserExtensionNamespace('alarms', {
    permission: 'alarms',
    methods: {
      create: defineBrowserExtensionMethod(
        z.union([z.tuple([infoSchema]), z.tuple([z.string().optional(), infoSchema])]),
        (caller, ...args) => {
          if (typeof args[0] === 'object') {
            create(caller, '', args[0])
          } else {
            create(caller, args[0] ?? '', args[1]!)
          }
        }
      ),
      get: defineBrowserExtensionMethod(z.tuple([z.string().optional()]), (caller, name) => {
        const alarm = stateFor(caller.session, caller.extension.id).alarms.get(
          (name ?? '').toWellFormed()
        )
        return alarm ? { ...alarm } : undefined
      }),
      getAll: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        [...stateFor(caller.session, caller.extension.id).alarms.values()].map((alarm) => ({
          ...alarm
        }))
      ),
      clear: defineBrowserExtensionMethod(z.tuple([z.string().optional()]), (caller, name) => {
        const state = stateFor(caller.session, caller.extension.id)
        const removed = state.alarms.delete((name ?? '').toWellFormed())
        schedule(state)
        return removed
      }),
      clearAll: defineBrowserExtensionMethod(z.tuple([]), (caller) => {
        const state = stateFor(caller.session, caller.extension.id)
        const removed = state.alarms.size > 0
        state.alarms.clear()
        schedule(state)
        return removed
      })
    },
    events: ['onAlarm']
  })
}
