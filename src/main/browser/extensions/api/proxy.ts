import { z } from 'zod'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../api-runtime/browser-extension-namespace-registry'
import { browserExtensionProxyConfigSchema } from '../proxy/browser-extension-proxy-config'
import {
  changeBrowserExtensionProxySetting,
  getBrowserExtensionProxySetting
} from '../proxy/browser-extension-proxy-session'

const scope = z.enum(['regular', 'regular_only']).optional()

export function registerProxyNamespace(): void {
  registerBrowserExtensionNamespace('proxy', {
    permission: 'proxy',
    methods: {
      'settings.get': defineBrowserExtensionMethod(
        z.tuple([z.object({ incognito: z.literal(false).optional() })]),
        (caller) => getBrowserExtensionProxySetting(caller.session, caller.extension.id)
      ),
      'settings.set': defineBrowserExtensionMethod(
        z.tuple([z.object({ value: browserExtensionProxyConfigSchema, scope })]),
        (caller, details) =>
          changeBrowserExtensionProxySetting(caller.session, caller.extension.id, details.value)
      ),
      'settings.clear': defineBrowserExtensionMethod(z.tuple([z.object({ scope })]), (caller) =>
        changeBrowserExtensionProxySetting(caller.session, caller.extension.id, undefined)
      )
    },
    events: ['settings.onChange', 'onProxyError']
  })
}
