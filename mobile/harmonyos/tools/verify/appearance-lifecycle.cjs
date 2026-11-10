const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')

test('system language follows the explicit Chinese script while a chosen app language stays active', () => {
  const values = new Map([['uiLanguagePreference', 'de']])
  let systemLanguage = 'zh-Hans-HK'
  const { applyUiLanguage } = loadArkts('settings/NativeUi.ets', ['applyUiLanguage'], {
    AppStorage: {
      get: (key) => values.get(key),
      setOrCreate: (key, value) => values.set(key, value)
    },
    i18n: { System: { getSystemLanguage: () => systemLanguage } }
  })

  applyUiLanguage()
  assert.equal(values.get('systemUiLocale'), 'zh')
  assert.equal(values.get('uiLocale'), 'de')

  systemLanguage = 'zh-Hant-CN'
  values.set('uiLanguagePreference', 'system')
  applyUiLanguage()
  assert.equal(values.get('systemUiLocale'), 'zh-Hant')
  assert.equal(values.get('uiLocale'), 'zh-Hant')
})

test('synchronous system theme callbacks do not reenter appearance configuration during startup', async () => {
  const values = new Map()
  const AppStorage = {
    get: (key) => values.get(key),
    setOrCreate: (key, value) => values.set(key, value)
  }
  const appearance = loadArkts(
    'settings/Appearance.ets',
    ['applyThemeMode', 'setSystemAppearance', 'loadAppearance', 'setAppearanceListener'],
    {
      AppStorage,
      getString: async () => 'dark',
      KEY_THEME_MODE: 'theme'
    }
  )
  let ability
  let delivering = false
  let dispatchError = null
  const context = {
    config: { colorMode: 0 },
    eventHub: { emit() {} },
    getApplicationContext: () => ({
      setColorMode(mode) {
        if (delivering) {
          dispatchError = new Error('System configuration was reentered')
          throw dispatchError
        }
        delivering = true
        try {
          ability.onConfigurationUpdate({ colorMode: mode })
        } finally {
          delivering = false
        }
      }
    })
  }
  const UIAbility = class {
    context = context
  }
  const { EntryAbility } = loadArkts('entryability/EntryAbility.ets', ['EntryAbility'], {
    UIAbility,
    AppStorage,
    ShellWindowRegions: class {
      start() {}
      dispose() {}
    },
    DefaultNetworkObserver: class {
      start() {}
      stop() {}
    },
    ...appearance,
    ConfigurationConstant: {
      ColorMode: { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 }
    },
    loadUiLanguage: async () => {},
    applyUiLanguage() {},
    setUiLocaleListener() {},
    closeIdleDesktopConnections() {},
    dropHomePrewarm() {},
    hilog: { info() {}, warn() {}, error() {} },
    $rawfile: (name) => name
  })
  ability = new EntryAbility()
  const mainWindow = {
    setWindowBackgroundColor() {},
    setWindowSystemBarProperties: async () => {},
    getUIContext: () => ({ getFont: () => ({ registerFont() {} }) })
  }
  ability.onCreate({}, {})
  ability.onWindowStageCreate({
    on() {},
    off() {},
    getMainWindow: async () => mainWindow,
    getMainWindowSync: () => mainWindow,
    loadContent(_page, callback) {
      callback({ code: 0 })
    }
  })
  await Promise.resolve()
  await Promise.resolve()
  appearance.applyThemeMode('light')
  assert.equal(dispatchError, null)
  ability.onWindowStageDestroy()
})

test('the app switcher saves before background and re-arms when the stage resumes', () => {
  const emitted = []
  const { EntryAbility } = loadArkts('entryability/EntryAbility.ets', ['EntryAbility'], {
    UIAbility: class {
      context = { eventHub: { emit: (event) => emitted.push(event) } }
    },
    window: { WindowStageEventType: { INACTIVE: 3, RESUMED: 5, PAUSED: 6 } },
    closeIdleDesktopConnections() {},
    dropHomePrewarm() {}
  })
  const ability = new EntryAbility()
  let stageChanged
  ability.onWindowStageCreate({
    on(_event, callback) {
      stageChanged = callback
    },
    loadContent() {}
  })

  stageChanged(6)
  assert.deepEqual(emitted, ['orcaAppInactive'])
  stageChanged(3)
  ability.onBackground()
  assert.deepEqual(emitted, ['orcaAppInactive', 'orcaBackground'])
  stageChanged(5)
  stageChanged(6)
  assert.deepEqual(emitted, ['orcaAppInactive', 'orcaBackground', 'orcaAppInactive'])
})
