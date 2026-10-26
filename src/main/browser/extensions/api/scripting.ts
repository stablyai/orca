import { z } from 'zod'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  runBrowserExtensionContentScriptMethod,
  type ContentScriptMethod
} from '../browser-extension-content-scripts'

export {
  forgetBrowserExtensionContentScriptRestore,
  restoreBrowserExtensionContentScripts
} from '../browser-extension-content-scripts'

const scriptSchema = z.object({ id: z.string().min(1) }).loose()
const filterSchema = z
  .object({ ids: z.array(z.string()) })
  .partial()
  .loose()

function run(caller: BrowserExtensionCaller, method: ContentScriptMethod, args: unknown[]) {
  return runBrowserExtensionContentScriptMethod(
    caller.session,
    caller.browserProfileId,
    caller.extension,
    method,
    args
  )
}

export function registerScriptingNamespaces(): void {
  registerBrowserExtensionNamespace('scripting', {
    permission: 'scripting',
    methods: {
      registerContentScripts: defineBrowserExtensionMethod(
        z.tuple([z.array(scriptSchema)]),
        (caller, scripts) => run(caller, 'registerContentScripts', [scripts])
      ),
      updateContentScripts: defineBrowserExtensionMethod(
        z.tuple([z.array(scriptSchema)]),
        (caller, scripts) => run(caller, 'updateContentScripts', [scripts])
      ),
      unregisterContentScripts: defineBrowserExtensionMethod(
        z.tuple([filterSchema.optional()]),
        (caller, filter) => run(caller, 'unregisterContentScripts', [filter ?? {}])
      ),
      getRegisteredContentScripts: defineBrowserExtensionMethod(
        z.tuple([filterSchema.optional()]),
        (caller, filter) => run(caller, 'getRegisteredContentScripts', filter ? [filter] : [])
      )
    },
    events: []
  })
}
