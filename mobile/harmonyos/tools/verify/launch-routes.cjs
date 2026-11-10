const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')
const shellRoutes = loadArkts(
  'navigation/ShellRoute.ets',
  ['desktopPath', 'shellRouterParams', 'readShellRoute', 'sessionOpenParam'],
  { bundleCompat: require('../../entry/src/main/ets/vendor/bundle-compat.js') }
)
const { parseLaunchRoute } = loadArkts(
  'navigation/LaunchRoute.ets',
  ['parseLaunchRoute'],
  shellRoutes
)
const host = '0123456789abcdef0123456789abcdef'

test('notification destination keeps a remote folder and pane independent of pathname', () => {
  const result = parseLaunchRoute(
    `orca://session?hostId=${host}&worktreeId=folder%3A%2Fsrv%2Fone&paneKey=terminal%3A2&executionHost=runtime%3Aserver%252Fone`
  )
  assert.equal(result.params.route, `/h/${host}/session/folder%3A%2Fsrv%2Fone`)
  assert.equal(result.params.executionHost, 'runtime:server%2Fone')
  assert.equal(result.params.paneKey, 'terminal:2')
  assert.equal(result.params.hostListFirst, '1')
  const route = shellRoutes.readShellRoute(result.params)
  assert.equal(shellRoutes.sessionOpenParam(route, 1), '')
  assert.equal(
    shellRoutes.sessionOpenParam(route, 3),
    `/h/${host}/session/folder%3A%2Fsrv%2Fone?paneKey=terminal%3A2&executionHost=runtime%3Aserver%252Fone`
  )
})

test('host-only notification opens the paired desktop route', () => {
  assert.equal(parseLaunchRoute(`orca://session?hostId=${host}`).params.route, `/h/${host}`)
  assert.equal(parseLaunchRoute(`orca://session?hostId=${host}`).params.hostListFirst, undefined)
})

test('ambiguous and malformed session destinations are refused', () => {
  assert.equal(
    parseLaunchRoute(`orca://session?hostId=${host}&hostId=${host}&worktreeId=one`),
    null
  )
  assert.equal(parseLaunchRoute(`orca://session?hostId=${host}&worktreeId=%00`), null)
  assert.equal(parseLaunchRoute(`orca://session?hostId=${host}&worktreeId=%ZZ`), null)
  assert.equal(parseLaunchRoute('https://example.com'), null)
})

function createLaunchFixture(...pages) {
  const stack = pages.map((url) => ({ url }))
  const router = {
    getState: () => ({ name: stack.at(-1).url.split('/').at(-1), index: stack.length }),
    async pushUrl(page) {
      await Promise.resolve()
      stack.push(page)
    },
    async replaceUrl(page) {
      stack.splice(-1, 1, page)
    }
  }
  const values = new Map()
  const { EntryAbility } = loadArkts('entryability/EntryAbility.ets', ['EntryAbility'], {
    UIAbility: class {},
    AppStorage: {
      get: (key) => values.get(key),
      setOrCreate: (key, value) => values.set(key, value)
    },
    ShellWindowRegions: class {
      start() {}
    },
    DefaultNetworkObserver: class {
      start() {}
    },
    setAppearanceListener() {},
    parseLaunchRoute,
    router,
    ConfigurationConstant: { ColorMode: { COLOR_MODE_NOT_SET: -1 } },
    hilog: { error() {}, warn() {} }
  })
  const ability = new EntryAbility()
  ability.onWindowStageCreate({
    loadContent: (_page, callback) => callback({ code: 0 }),
    getMainWindowSync: () => ({
      setWindowSystemBarProperties: async () => {},
      getUIContext: () => ({ getRouter: () => router })
    })
  })
  return { ability, stack }
}

test('a newer external pairing link replaces the pending confirmation and keeps Home below it', async () => {
  const { ability, stack } = createLaunchFixture('pages/Home')
  ability.onNewWant({ uri: 'orca://pair?code=old' })
  ability.onNewWant({ uri: 'orca://pair?code=new' })
  await new Promise(setImmediate)
  assert.deepEqual(
    stack.map((page) => page.url),
    ['pages/Home', 'pages/PairScan']
  )
  assert.equal(stack.at(-1).params.pairingCode, 'orca://pair?code=new')
})

test('an external pairing link replaces the open desktop so Back can return to Home after pairing', async () => {
  const { ability, stack } = createLaunchFixture('pages/Home', 'pages/ShellScreen')
  ability.onNewWant({ uri: 'orca://pair?code=new' })
  await new Promise(setImmediate)
  assert.deepEqual(
    stack.map((page) => page.url),
    ['pages/Home', 'pages/PairScan']
  )
})
