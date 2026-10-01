/**
 * Why here and not in shared/: main's build also bundles this preload, and a module both import
 * becomes a chunk the sandboxed preload cannot load. Main needs none of this.
 *
 * The chrome.* surface Orca adds to extensions: namespaces Electron lacks, and the tab and action
 * APIs Electron has but cannot back, since only Orca knows its tabs and draws its toolbar.
 * Everything else (runtime messaging, storage, scripting, alarms, i18n, …) stays Electron's own.
 */
export type BrowserExtensionNamespace = {
  methods: readonly string[]
  events: readonly string[]
  constants?: Readonly<Record<string, unknown>>
}

export const BROWSER_EXTENSION_API: Readonly<Record<string, BrowserExtensionNamespace>> = {
  tabs: {
    methods: ['get', 'getCurrent', 'query', 'create', 'update', 'remove'],
    events: ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onHighlighted'],
    constants: { TAB_ID_NONE: -1 }
  },
  windows: {
    methods: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'],
    events: ['onCreated', 'onRemoved', 'onFocusChanged'],
    constants: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 }
  },
  action: {
    methods: [
      'setIcon',
      'setTitle',
      'getTitle',
      'setPopup',
      'getPopup',
      'setBadgeText',
      'getBadgeText',
      'setBadgeBackgroundColor',
      'getBadgeBackgroundColor',
      'setBadgeTextColor',
      'getBadgeTextColor',
      'enable',
      'disable',
      'isEnabled',
      'openPopup',
      'getUserSettings'
    ],
    events: ['onClicked']
  },
  contextMenus: {
    methods: ['create', 'update', 'remove', 'removeAll'],
    events: ['onClicked'],
    constants: { ACTION_MENU_TOP_LEVEL_LIMIT: 6 }
  },
  commands: { methods: ['getAll'], events: ['onCommand'] },
  webNavigation: {
    methods: ['getFrame', 'getAllFrames'],
    events: [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onErrorOccurred',
      'onHistoryStateUpdated'
    ]
  },
  notifications: {
    methods: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'],
    events: ['onClicked', 'onClosed', 'onButtonClicked']
  },
  cookies: {
    methods: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
    events: ['onChanged']
  },
  downloads: { methods: ['download'], events: ['onCreated', 'onChanged'] },
  permissions: {
    methods: ['contains', 'getAll', 'request', 'remove'],
    events: ['onAdded', 'onRemoved']
  },
  management: { methods: ['getAll', 'get'], events: [] },
  runtime: { methods: ['sendNativeMessage'], events: [] }
}

/** chrome.privacy settings, each a ChromeSetting an extension can read and set. */
export const BROWSER_EXTENSION_PRIVACY_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  services: [
    'alternateErrorPagesEnabled',
    'autofillAddressEnabled',
    'autofillCreditCardEnabled',
    'passwordSavingEnabled',
    'safeBrowsingEnabled',
    'searchSuggestEnabled',
    'spellingServiceEnabled',
    'translationServiceEnabled'
  ],
  network: ['networkPredictionEnabled', 'webRTCIPHandlingPolicy'],
  websites: ['hyperlinkAuditingEnabled', 'referrersEnabled', 'doNotTrackEnabled']
}

// Copies of shared/browser-extension-channels, for the same reason; a test keeps them equal.
export const BROWSER_EXTENSION_CALL_CHANNEL = 'orca-browser-extension:call'
export const BROWSER_EXTENSION_EVENT_CHANNEL = 'orca-browser-extension:event'
