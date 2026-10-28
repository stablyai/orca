/**
 * What the extension preload installs on `chrome`/`browser`. Main's namespace registry is the
 * authority (it validates every call); this list only tells the preload which functions and events
 * to create before extension code runs. A test pins it to main's registry.
 *
 * Why written out here: this module is bundled into a sandboxed preload whose `require` resolves
 * only 'electron', so importing shared code would emit a chunk the context cannot load.
 */

export const PRELOAD_BROWSER_EXTENSION_INVOKE_CHANNEL = 'browserExtension:invoke'
export const PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL = 'browserExtension:event'

export type BrowserExtensionSurfaceMethod = {
  /**
   * Run Electron's own implementation first (callback style) and send its result to main as the
   * last argument. `omitKeys` are removed from the first argument before the native call;
   * `nullOnError` sends null instead of failing, for ids only main knows (discarded tabs).
   */
  native?: { omitKeys?: string[]; nullOnError?: boolean }
  /** contextMenus.create: the preload picks the id and returns it synchronously, as Chrome does. */
  returnsCreatedId?: boolean
}

export type BrowserExtensionSurfaceNamespace = {
  /** Installed only when the manifest declares it (any one of a list); main enforces the same rule. */
  permission?: string | readonly string[]
  /** Installed only when the manifest has this top-level key (chrome.action needs "action"). */
  manifestKey?: string
  methods: Record<string, BrowserExtensionSurfaceMethod>
  events: string[]
  constants?: Record<string, number>
}

export type BrowserExtensionSurface = Record<string, BrowserExtensionSurfaceNamespace>

// Orca owns all action state (Electron's built-ins keep none main can read), so nothing runs natively.
const ACTION_SURFACE: BrowserExtensionSurfaceNamespace = {
  methods: {
    setTitle: {},
    getTitle: {},
    setIcon: {},
    setPopup: {},
    getPopup: {},
    setBadgeText: {},
    getBadgeText: {},
    setBadgeBackgroundColor: {},
    getBadgeBackgroundColor: {},
    setBadgeTextColor: {},
    getBadgeTextColor: {},
    enable: {},
    disable: {},
    isEnabled: {},
    getUserSettings: {},
    openPopup: {}
  },
  events: ['onClicked', 'onUserSettingsChanged']
}

// types.ChromeSetting members for each chrome.privacy setting main registers.
const PRIVACY_SETTINGS = [
  'services.passwordSavingEnabled',
  'services.autofillEnabled',
  'services.autofillAddressEnabled',
  'services.autofillCreditCardEnabled',
  'network.networkPredictionEnabled',
  'network.webRTCIPHandlingPolicy',
  'websites.thirdPartyCookiesAllowed',
  'websites.hyperlinkAuditingEnabled',
  'websites.referrersEnabled',
  'websites.doNotTrackEnabled',
  'websites.protectedContentEnabled',
  'services.alternateErrorPagesEnabled',
  'websites.topicsEnabled',
  'websites.fledgeEnabled',
  'websites.adMeasurementEnabled'
]

const PRIVACY_SURFACE: BrowserExtensionSurfaceNamespace = {
  permission: 'privacy',
  methods: Object.fromEntries(
    PRIVACY_SETTINGS.flatMap((setting) =>
      ['get', 'set', 'clear'].map((member) => [`${setting}.${member}`, {}])
    )
  ),
  events: PRIVACY_SETTINGS.map((setting) => `${setting}.onChange`)
}

export const BROWSER_EXTENSION_API_SURFACE: BrowserExtensionSurface = {
  windows: {
    methods: {
      getAll: {},
      get: {},
      getCurrent: {},
      getLastFocused: {},
      create: {},
      update: {},
      remove: {}
    },
    events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
    constants: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 }
  },
  tabs: {
    methods: {
      // Electron answers url/title (with its permission checks); Orca adds window and activation.
      query: {
        native: {
          omitKeys: [
            'active',
            'highlighted',
            'currentWindow',
            'lastFocusedWindow',
            'windowId',
            'windowType',
            'status',
            'index',
            'pinned',
            'discarded',
            'frozen',
            'groupId'
          ]
        }
      },
      get: { native: { nullOnError: true } },
      getCurrent: {},
      create: {},
      duplicate: {},
      remove: {},
      update: {},
      captureVisibleTab: {},
      goBack: {},
      goForward: {},
      move: {},
      discard: {},
      detectLanguage: {}
    },
    events: ['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onReplaced'],
    constants: { TAB_ID_NONE: -1 }
  },
  webNavigation: {
    permission: 'webNavigation',
    methods: { getFrame: {}, getAllFrames: {} },
    events: [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onErrorOccurred',
      'onHistoryStateUpdated',
      'onReferenceFragmentUpdated',
      'onCreatedNavigationTarget'
    ]
  },
  // Why Orca's events: Electron never fires these, and a native one would double-fire if it starts.
  runtime: {
    methods: { openOptionsPage: {} },
    events: ['onInstalled', 'onStartup']
  },
  extension: {
    methods: { isAllowedFileSchemeAccess: {}, isAllowedIncognitoAccess: {} },
    events: []
  },
  action: { ...ACTION_SURFACE, manifestKey: 'action' },
  browserAction: { ...ACTION_SURFACE, manifestKey: 'browser_action' },
  permissions: {
    methods: { contains: {}, getAll: {}, request: {}, remove: {} },
    events: ['onAdded', 'onRemoved']
  },
  notifications: {
    permission: 'notifications',
    methods: { create: {}, update: {}, clear: {}, getAll: {}, getPermissionLevel: {} },
    events: ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged']
  },
  contextMenus: {
    permission: 'contextMenus',
    methods: { create: { returnsCreatedId: true }, update: {}, remove: {}, removeAll: {} },
    events: ['onClicked'],
    constants: { ACTION_MENU_TOP_LEVEL_LIMIT: 6 }
  },
  commands: { methods: { getAll: {} }, events: ['onCommand'] },
  privacy: PRIVACY_SURFACE,
  cookies: {
    permission: 'cookies',
    methods: { get: {}, getAll: {}, set: {}, remove: {}, getAllCookieStores: {} },
    events: ['onChanged']
  },
  scripting: {
    permission: 'scripting',
    methods: {
      registerContentScripts: {},
      updateContentScripts: {},
      unregisterContentScripts: {},
      getRegisteredContentScripts: {}
    },
    events: []
  },
  webRequest: {
    permission: 'webRequest',
    methods: {},
    events: [
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onSendHeaders',
      'onHeadersReceived',
      'onResponseStarted',
      'onBeforeRedirect',
      'onCompleted',
      'onErrorOccurred'
    ]
  },
  downloads: {
    permission: 'downloads',
    methods: { download: {} },
    events: ['onCreated', 'onChanged']
  },
  // Electron's native methods succeed but enforce nothing; onRuleMatchedDebug stays native.
  declarativeNetRequest: {
    permission: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
    methods: {
      updateDynamicRules: {},
      getDynamicRules: {},
      updateSessionRules: {},
      getSessionRules: {},
      updateEnabledRulesets: {},
      getEnabledRulesets: {},
      updateStaticRules: {},
      getDisabledRuleIds: {},
      getAvailableStaticRuleCount: {},
      isRegexSupported: {},
      testMatchOutcome: {},
      setExtensionActionOptions: {},
      getMatchedRules: {}
    },
    events: [],
    constants: {
      GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
      MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50
    }
  },
  // Added beside Electron's native getSelf/uninstallSelf.
  management: {
    permission: 'management',
    methods: { getAll: {}, get: {}, setEnabled: {} },
    events: []
  }
}
