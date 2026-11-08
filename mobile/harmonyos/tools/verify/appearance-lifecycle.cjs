const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')

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
    ...appearance,
    ConfigurationConstant: {
      ColorMode: { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 }
    },
    loadUiLanguage: async () => {},
    applyUiLanguage() {},
    setUiLocaleListener() {},
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
