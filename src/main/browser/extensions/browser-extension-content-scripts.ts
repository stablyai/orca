import { z } from 'zod'
import { getBrowserExtensionContextSignal } from './browser-extension-context-lifetime'
import { getHostSessionState } from './browser-extension-contexts'
import { runBrowserExtensionNativePage } from './browser-extension-native-page'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'

export type ContentScriptMethod =
  | 'registerContentScripts'
  | 'updateContentScripts'
  | 'unregisterContentScripts'
  | 'getRegisteredContentScripts'

type NativeContentScriptMethods = Partial<Record<ContentScriptMethod, unknown>>

type ScriptState = {
  queue: Promise<unknown>
  controller: AbortController
  signal: AbortSignal
  restored: boolean
  failed: Error | null
}
const states = new WeakMap<Electron.Session, Map<string, ScriptState>>()
const scriptSchema = z.object({ id: z.string() }).loose()
const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), scripts: z.array(scriptSchema), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() })
])

// Serialized into a native-only extension page; keep all its dependencies inside this function.
async function runNativeScripts(
  method: ContentScriptMethod | null,
  args: unknown[],
  restore: Record<string, unknown>[]
): Promise<unknown> {
  const root: { chrome?: unknown } = globalThis
  const chromeApi = root.chrome
  if (!chromeApi || typeof chromeApi !== 'object' || !('scripting' in chromeApi)) {
    throw new Error('Native scripting API is unavailable')
  }
  const scripting = chromeApi.scripting
  if (!scripting || typeof scripting !== 'object') {
    throw new Error('Native scripting API is unavailable')
  }
  const methods: NativeContentScriptMethods = scripting
  const call = (name: ContentScriptMethod, input: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const fn = methods[name]
      if (typeof fn !== 'function') {
        reject(new Error('Native scripting method is unavailable'))
        return
      }
      fn.call(scripting, ...input, (value: unknown) => {
        const runtime = 'runtime' in chromeApi ? chromeApi.runtime : null
        const error =
          runtime && typeof runtime === 'object' && 'lastError' in runtime
            ? runtime.lastError
            : null
        if (error && typeof error === 'object' && 'message' in error) {
          reject(new Error(String(error.message)))
        } else {
          resolve(value)
        }
      })
    })
  // A failed restore retires this owner; partially restored registrations are never called ready.
  for (const script of restore) {
    await call('registerContentScripts', [[script]])
  }
  let value: unknown
  try {
    value = method ? await call(method, args) : undefined
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, scripts: await call('getRegisteredContentScripts', []), value }
}

function stateFor(session: Electron.Session, extensionId: string): ScriptState {
  let byId = states.get(session)
  if (!byId) {
    byId = new Map()
    states.set(session, byId)
  }
  let state = byId.get(extensionId)
  if (!state) {
    const controller = new AbortController()
    const host = getHostSessionState(session)
    state = {
      queue: Promise.resolve(),
      controller,
      signal: host
        ? AbortSignal.any([controller.signal, getBrowserExtensionContextSignal(host, extensionId)])
        : controller.signal,
      restored: false,
      failed: null
    }
    byId.set(extensionId, state)
  }
  return state
}

export function forgetBrowserExtensionContentScriptRestore(
  session: Electron.Session,
  extensionId: string
): void {
  states.get(session)?.get(extensionId)?.controller.abort()
  states.get(session)?.delete(extensionId)
}

function enqueue(
  session: Electron.Session,
  profileId: string,
  extension: Electron.Extension,
  method: ContentScriptMethod | null,
  args: unknown[],
  timeoutMs: number
): Promise<unknown> {
  const state = stateFor(session, extension.id)
  const run = state.queue.then(async () => {
    state.signal.throwIfAborted()
    if (state.failed) {
      throw state.failed
    }
    const store = getBrowserExtensionProfileStateStore()
    const restore = state.restored ? [] : store.read(profileId, extension.id).contentScripts
    if (!method && restore.length === 0) {
      state.restored = true
      return
    }
    let raw: unknown
    try {
      raw = await runBrowserExtensionNativePage({
        session,
        extensionId: extension.id,
        code: `(${runNativeScripts.toString()})(${JSON.stringify(method)},${JSON.stringify(args)},${JSON.stringify(restore)})`,
        timeoutMs,
        signal: state.signal
      })
      state.signal.throwIfAborted()
    } catch (error) {
      // A lost context may still have dispatched native work; only a reload can safely retry it.
      state.failed = error instanceof Error ? error : new Error(String(error))
      throw state.failed
    }
    const reply = replySchema.parse(raw)
    state.restored = true
    if (!reply.ok) {
      throw new Error(reply.error)
    }
    store.update(profileId, extension.id, (stored) => ({
      ...stored,
      contentScripts: reply.scripts.filter((script) => script.persistAcrossSessions !== false)
    }))
    return reply.value
  })
  state.queue = run.catch(() => undefined)
  return run
}

export async function restoreBrowserExtensionContentScripts(
  session: Electron.Session,
  profileId: string,
  extension: Electron.Extension,
  timeoutMs: number
): Promise<void> {
  await enqueue(session, profileId, extension, null, [], timeoutMs)
}

export function runBrowserExtensionContentScriptMethod(
  session: Electron.Session,
  profileId: string,
  extension: Electron.Extension,
  method: ContentScriptMethod,
  args: unknown[]
): Promise<unknown> {
  return enqueue(session, profileId, extension, method, args, 5_000)
}
