const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')
const { parseLaunchRoute } = loadArkts('navigation/LaunchRoute.ets', ['parseLaunchRoute'])
const host = '0123456789abcdef0123456789abcdef'

test('notification destination keeps a remote folder and pane independent of pathname', () => {
  const result = parseLaunchRoute(
    `orca://session?hostId=${host}&worktreeId=folder%3A%2Fsrv%2Fone&paneKey=terminal%3A2&executionHost=runtime%3Aserver%252Fone`
  )
  assert.equal(result.params.route, `/h/${host}/session/folder%3A%2Fsrv%2Fone`)
  assert.equal(result.params.executionHost, 'runtime:server%2Fone')
  assert.equal(result.params.paneKey, 'terminal:2')
})

test('host-only notification opens the paired desktop route', () => {
  assert.equal(parseLaunchRoute(`orca://session?hostId=${host}`).params.route, `/h/${host}`)
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
