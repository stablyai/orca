const { test } = require('node:test')
const assert = require('node:assert/strict')
const { guardBrowserProcessStartup } = require('./android-browser-process')

test('guest guard precedes React/Expo startup and is idempotent', () => {
  const source = `override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }`
  const guarded = guardBrowserProcessStartup(source)
  assert.equal(guardBrowserProcessStartup(guarded), guarded)
  assert.equal(guarded.match(/:orca_browser/g).length, 2)
  assert.match(guarded, /super.onCreate\(\)\s+if .*:orca_browser.* return\s+loadReactNative/)
  assert.throws(
    () => guardBrowserProcessStartup('unexpected template'),
    /Missing Android startup anchor/
  )
})
