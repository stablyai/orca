const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')

function onboardingStore() {
  const values = new Map()
  let failWrite = false
  const prefs = {
    hasSync: (key) => values.has(key),
    getSync: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    putSync: (key, value) => values.set(key, value),
    deleteSync: (key) => values.delete(key),
    flushSync() {
      if (failWrite) {
        failWrite = false
        throw new Error('disk unavailable')
      }
    }
  }
  const preferences = { getPreferencesSync: () => prefs }
  const settings = loadArkts(
    'settings/SettingsStore.ets',
    ['setString', 'setBool', 'KEY_DEFAULT_SESSION_VIEW', 'KEY_NOTIFICATIONS_LOCAL_ENABLED'],
    { preferences }
  )
  const flow = loadArkts(
    'onboarding/MobileOnboardingPlan.ets',
    ['loadMobileOnboardingSteps', 'saveOnboardingSessionView', 'saveOnboardingOnlineNotifications'],
    { preferences, ...settings }
  )
  return {
    ...flow,
    failNextWrite() {
      failWrite = true
    }
  }
}

test('first-run choices persist in order and are not offered again after reopening', async () => {
  const flow = onboardingStore()
  assert.deepEqual(Array.from(flow.loadMobileOnboardingSteps({})), [
    'session-view',
    'online-notifications'
  ])
  await flow.saveOnboardingSessionView({}, 'chat')
  assert.deepEqual(Array.from(flow.loadMobileOnboardingSteps({})), ['online-notifications'])
  await flow.saveOnboardingOnlineNotifications({}, false)
  assert.deepEqual(Array.from(flow.loadMobileOnboardingSteps({})), [])
})

test('a failed save leaves the first-run choice pending instead of advancing', async () => {
  const flow = onboardingStore()
  flow.failNextWrite()
  await assert.rejects(flow.saveOnboardingSessionView({}, 'terminal'), /disk unavailable/)
  assert.deepEqual(Array.from(flow.loadMobileOnboardingSteps({})), [
    'session-view',
    'online-notifications'
  ])
  await flow.saveOnboardingSessionView({}, 'terminal')
  flow.failNextWrite()
  await assert.rejects(flow.saveOnboardingOnlineNotifications({}, true), /disk unavailable/)
  assert.deepEqual(Array.from(flow.loadMobileOnboardingSteps({})), ['online-notifications'])
})
