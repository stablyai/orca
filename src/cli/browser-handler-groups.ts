import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the browser command surface is a third of the CLI's groups and
// changes as a unit, so it keeps handler-group-manifest.ts readable at a glance.
export const BROWSER_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'browser-nav',
    keys: [
      'snapshot',
      'screenshot',
      'goto',
      'back',
      'reload',
      'forward',
      'eval',
      'scroll',
      'wait',
      'pdf',
      'full-screenshot'
    ],
    load: async () => (await import('./handlers/browser-nav.js')).BROWSER_NAV_HANDLERS
  },
  {
    name: 'browser-interact',
    keys: [
      'click',
      'dblclick',
      'fill',
      'type',
      'select',
      'check',
      'uncheck',
      'focus',
      'clear',
      'select-all',
      'keypress',
      'hover',
      'drag',
      'upload',
      'scrollintoview',
      'get',
      'is',
      'inserttext',
      'mouse move',
      'mouse down',
      'mouse up',
      'mouse wheel',
      'find',
      'download',
      'highlight'
    ],
    load: async () => (await import('./handlers/browser-interact.js')).BROWSER_INTERACT_HANDLERS
  },
  {
    name: 'browser-tab',
    keys: ['tab list', 'tab show', 'tab current', 'tab switch', 'tab create', 'tab close', 'exec'],
    load: async () => (await import('./handlers/browser-tab.js')).BROWSER_TAB_HANDLERS
  },
  {
    name: 'browser-profile',
    keys: [
      'tab profile list',
      'tab profile create',
      'tab profile delete',
      'tab profile set',
      'tab profile show',
      'tab profile use-default',
      'tab profile clone'
    ],
    load: async () => (await import('./handlers/browser-profile.js')).BROWSER_PROFILE_HANDLERS
  },
  {
    name: 'browser-cookie',
    keys: ['cookie get', 'cookie set', 'cookie delete'],
    load: async () => (await import('./handlers/browser-cookie.js')).BROWSER_COOKIE_HANDLERS
  },
  {
    name: 'browser-capture',
    keys: [
      'intercept enable',
      'intercept disable',
      'intercept list',
      'capture start',
      'capture stop',
      'console',
      'network'
    ],
    load: async () => (await import('./handlers/browser-capture.js')).BROWSER_CAPTURE_HANDLERS
  },
  {
    name: 'browser-env',
    keys: [
      'viewport',
      'geolocation',
      'set device',
      'set offline',
      'set headers',
      'set credentials',
      'set media',
      'clipboard read',
      'clipboard write',
      'dialog accept',
      'dialog dismiss'
    ],
    load: async () => (await import('./handlers/browser-env.js')).BROWSER_ENV_HANDLERS
  },
  {
    name: 'browser-storage',
    keys: [
      'storage local get',
      'storage local set',
      'storage local clear',
      'storage session get',
      'storage session set',
      'storage session clear'
    ],
    load: async () => (await import('./handlers/browser-storage.js')).BROWSER_STORAGE_HANDLERS
  }
]
