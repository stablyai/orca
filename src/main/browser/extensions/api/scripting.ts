import { z } from 'zod'
import { getChromeExtensionOrigin } from '../../../../shared/browser-extension-url'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { getBrowserExtensionProfileStateStore } from '../browser-extension-profile-state-store'

/**
 * Chrome keeps scripting.registerContentScripts registrations across restarts unless
 * persistAcrossSessions is false; Electron forgets them. Orca records them after Electron's own
 * call succeeds and hands them back to the worker once per session (see the worker shim's
 * browser-extension-content-script-restore.ts), before restored tabs navigate.
 */

type RegisteredScript = Record<string, unknown> & { id: string }

const scriptSchema = z.object({ id: z.string().min(1) }).loose()
const filterSchema = z
  .object({ ids: z.array(z.string()) })
  .partial()
  .loose()

const RESTORE_NAMESPACE = 'orcaContentScriptRestore'

export function withRegisteredScripts(
  stored: Record<string, unknown>[],
  scripts: RegisteredScript[]
): Record<string, unknown>[] {
  const persisted = scripts.filter((script) => script.persistAcrossSessions !== false)
  const ids = new Set(persisted.map((script) => script.id))
  return [...stored.filter((script) => !ids.has(String(script.id))), ...persisted]
}

export function withUpdatedScripts(
  stored: Record<string, unknown>[],
  updates: RegisteredScript[]
): Record<string, unknown>[] {
  return stored.flatMap((script) => {
    const update = updates.find((candidate) => candidate.id === script.id)
    if (!update) {
      return [script]
    }
    const merged = { ...script, ...update }
    return merged.persistAcrossSessions === false ? [] : [merged]
  })
}

export function withoutScripts(
  stored: Record<string, unknown>[],
  ids: string[] | undefined
): Record<string, unknown>[] {
  return ids ? stored.filter((script) => !ids.includes(String(script.id))) : []
}

function editScripts(
  caller: BrowserExtensionCaller,
  change: (stored: Record<string, unknown>[]) => Record<string, unknown>[]
): void {
  getBrowserExtensionProfileStateStore().update(
    caller.browserProfileId,
    caller.extension.id,
    (state) => ({
      ...state,
      contentScripts: change(state.contentScripts)
    })
  )
}

type RestoreState = { taken: boolean; done: boolean; waiters: (() => void)[] }
const restoreBySession = new WeakMap<Electron.Session, Map<string, RestoreState>>()

function restoreState(session: Electron.Session, extensionId: string): RestoreState {
  let byExtension = restoreBySession.get(session)
  if (!byExtension) {
    byExtension = new Map()
    restoreBySession.set(session, byExtension)
  }
  let state = byExtension.get(extensionId)
  if (!state) {
    state = { taken: false, done: false, waiters: [] }
    byExtension.set(extensionId, state)
  }
  return state
}

function finishRestore(state: RestoreState): void {
  state.done = true
  for (const resolve of state.waiters.splice(0)) {
    resolve()
  }
}

/** An unloaded extension loses Electron's registrations, so its next load restores again. */
export function forgetBrowserExtensionContentScriptRestore(
  session: Electron.Session,
  extensionId: string
): void {
  restoreBySession.get(session)?.delete(extensionId)
}

/**
 * Session load: resolves once the extension's worker re-registered its persisted scripts, or after
 * `timeoutMs` (a broken worker must not hold up the browser).
 */
export async function restoreBrowserExtensionContentScripts(
  session: Electron.Session,
  browserProfileId: string,
  extension: Electron.Extension,
  timeoutMs: number
): Promise<void> {
  const stored = getBrowserExtensionProfileStateStore().read(browserProfileId, extension.id)
  const state = restoreState(session, extension.id)
  if (stored.contentScripts.length === 0 || state.done) {
    return
  }
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    new Promise<void>((resolve) => {
      state.waiters.push(resolve)
      if (!state.taken) {
        // Why: the worker shim asks for the scripts whenever the worker starts; make sure it does.
        session.serviceWorkers
          .startWorkerForScope(`${getChromeExtensionOrigin(extension.id)}/`)
          .catch(() => undefined)
      }
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

export function registerScriptingNamespaces(): void {
  registerBrowserExtensionNamespace('scripting', {
    permission: 'scripting',
    methods: {
      // Electron registers natively first; its (empty) result rides along as the last argument.
      registerContentScripts: defineBrowserExtensionMethod(
        z.tuple([z.array(scriptSchema), z.unknown()]),
        (caller, scripts) => editScripts(caller, (stored) => withRegisteredScripts(stored, scripts))
      ),
      updateContentScripts: defineBrowserExtensionMethod(
        z.tuple([z.array(scriptSchema), z.unknown()]),
        (caller, scripts) => editScripts(caller, (stored) => withUpdatedScripts(stored, scripts))
      ),
      unregisterContentScripts: defineBrowserExtensionMethod(
        z.tuple([filterSchema.optional(), z.unknown().optional()]),
        (caller, filter) => editScripts(caller, (stored) => withoutScripts(stored, filter?.ids))
      )
    },
    events: []
  })
  // Shim-only: never on the API surface, so extension code does not see it.
  registerBrowserExtensionNamespace(RESTORE_NAMESPACE, {
    methods: {
      take: defineBrowserExtensionMethod(z.tuple([]), (caller) => {
        if (!caller.fromWorker) {
          throw new BrowserExtensionApiError('Only the extension worker restores scripts')
        }
        const state = restoreState(caller.session, caller.extension.id)
        if (state.taken) {
          return []
        }
        state.taken = true
        const { contentScripts } = getBrowserExtensionProfileStateStore().read(
          caller.browserProfileId,
          caller.extension.id
        )
        if (contentScripts.length === 0) {
          finishRestore(state)
        }
        return contentScripts
      }),
      done: defineBrowserExtensionMethod(z.tuple([z.number().int()]), (caller, failures) => {
        if (failures > 0) {
          console.info(
            `[browser-extensions] ${caller.extension.id} kept ${failures} content script(s) it re-registered itself`
          )
        }
        finishRestore(restoreState(caller.session, caller.extension.id))
      })
    },
    events: []
  })
}
