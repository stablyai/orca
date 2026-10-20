import type { BrowserExtensionInvokeReply } from './browser-extension-main-world'

/** Main-only namespace the worker shim uses for restart restore; never installed on `chrome`. */
export const PRELOAD_CONTENT_SCRIPT_RESTORE_NAMESPACE = 'orcaContentScriptRestore'

type ChromeRoot = { chrome?: unknown }

/**
 * Registers each script alone so one the extension already re-registered cannot sink the rest,
 * and resolves with how many failed.
 */
export function registerPersistedContentScripts(
  root: ChromeRoot,
  scripts: unknown[]
): Promise<number> {
  const chromeApi = root.chrome
  const scripting =
    chromeApi !== null && typeof chromeApi === 'object' && 'scripting' in chromeApi
      ? chromeApi.scripting
      : null
  const register =
    scripting !== null && typeof scripting === 'object' && 'registerContentScripts' in scripting
      ? scripting.registerContentScripts
      : null
  if (typeof register !== 'function') {
    return Promise.resolve(scripts.length)
  }
  return Promise.allSettled(
    scripts.map(
      (script) =>
        new Promise<void>((resolve, reject) => {
          register.call(scripting, [script], () => {
            const runtime: unknown =
              chromeApi !== null && typeof chromeApi === 'object' && 'runtime' in chromeApi
                ? chromeApi.runtime
                : null
            const failed =
              runtime !== null &&
              typeof runtime === 'object' &&
              'lastError' in runtime &&
              Boolean(runtime.lastError)
            if (failed) {
              reject(new Error('register failed'))
            } else {
              resolve()
            }
          })
        })
    )
  ).then((results) => results.filter((result) => result.status === 'rejected').length)
}

/**
 * Chrome restores persistAcrossSessions scripts on restart; Electron does not. Main hands the
 * recorded scripts to the worker once per session, and they are registered with Electron's own API.
 */
export async function restorePersistedContentScripts(
  invoke: (request: unknown) => Promise<BrowserExtensionInvokeReply>,
  root: ChromeRoot
): Promise<void> {
  const reply = await invoke({
    type: 'call',
    namespace: PRELOAD_CONTENT_SCRIPT_RESTORE_NAMESPACE,
    method: 'take',
    args: []
  })
  if (!reply.ok || !Array.isArray(reply.value) || reply.value.length === 0) {
    return
  }
  const failures = await registerPersistedContentScripts(root, reply.value)
  await invoke({
    type: 'call',
    namespace: PRELOAD_CONTENT_SCRIPT_RESTORE_NAMESPACE,
    method: 'done',
    args: [failures]
  })
}
