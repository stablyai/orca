import { z } from 'zod'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../browser-extension-namespace-registry'

/** Electron's chrome.extension lacks these; Orca loads extensions without file or incognito access. */
export function registerExtensionNamespace(): void {
  registerBrowserExtensionNamespace('extension', {
    methods: {
      isAllowedFileSchemeAccess: defineBrowserExtensionMethod(z.tuple([]), () => false),
      isAllowedIncognitoAccess: defineBrowserExtensionMethod(z.tuple([]), () => false)
    },
    events: []
  })
}
