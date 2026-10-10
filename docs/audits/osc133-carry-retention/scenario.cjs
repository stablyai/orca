const assert = require('node:assert/strict')

const inputs = [
  { name: 'captured-fish-prompt-partial', suffix: '\x1b]133;A;click_events=1', retained: true },
  { name: 'captured-fish-command-partial', suffix: '\x1b]133;C;cmdline_url=npx', retained: true },
  { name: 'short-standard-finished-partial', suffix: '\x1b]133;D;0', retained: false },
  {
    name: 'captured-fish-command-complete',
    suffix: '\x1b]133;C;cmdline_url=npx\x07',
    retained: false
  },
  { name: 'no-escape', suffix: 'ordinary output', retained: false },
  { name: 'oversized-incomplete-protocol', suffix: `\x1b]133;${'x'.repeat(5000)}`, retained: true }
]

async function heap() {
  ;/(?:)/.test('')
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
  return process.memoryUsage().heapUsed
}

function makeOwner(api, ownerKind, input, chars, index) {
  const prefix = `${index}:`
  const data = prefix + 'x'.repeat(chars - prefix.length - input.suffix.length) + input.suffix
  if (ownerKind === 'scanner') {
    const scanner = api.createOsc133CommandFinishedScanner(() => {})
    scanner.scan(data)
    return { complete: () => scanner.scan('\x07'), release: () => scanner.reset() }
  }
  if (ownerKind === 'title-tracker') {
    const tracker = api.createTerminalTitleTracker({ onCommandFinished: () => {} })
    tracker.handleChunk(data, { titleScanData: '' })
    return {
      complete: () => tracker.handleChunk('\x07', { titleScanData: '' }),
      release: () => tracker.dispose()
    }
  }
  const relay = new api.BackgroundTransientFactRelay(() => {})
  relay.setSessionBackground('fixture-session', true)
  relay.onSessionData('fixture-session', data)
  return {
    complete: () => relay.onSessionData('fixture-session', '\x07'),
    release: () => relay.onSessionExit('fixture-session')
  }
}

function behavior(api) {
  const emitted = []
  const scanner = api.createOsc133CommandFinishedScanner(
    (code) => emitted.push(['finished', code]),
    () => emitted.push(['started'])
  )
  for (const chunk of [
    '\x1b]133;A;click_events=1',
    '\x07',
    '\x1b]133;C;cmdline_url=npx',
    '\x07',
    '\x1b]133;D;13',
    '7\x1b',
    '\\',
    '\x1b]133;D;0\x07',
    '\x1b]133;D;not-a-number\x07'
  ]) {
    scanner.scan(chunk)
  }
  scanner.scan('\x1b]133;D;1234567890')
  scanner.reset()
  scanner.scan('\x07')
  assert.deepEqual(emitted, [['started'], ['finished', 137], ['finished', 0], ['finished', null]])
  const facts = []
  const relay = new api.BackgroundTransientFactRelay((id, fact) => facts.push([id, fact]))
  relay.setSessionBackground('s', true)
  relay.onSessionData('s', '\x1b]133;D;137')
  relay.onSessionData('s', '\x07')
  relay.onSessionData('s', '\x1b]133;D;22')
  relay.setSessionBackground('s', false)
  relay.setSessionBackground('s', true)
  relay.onSessionData('s', '\x07')
  relay.dispose()
  assert.deepEqual(facts[0], ['s', { kind: 'command-finished', exitCode: 137 }])
  assert.equal(facts.filter(([, fact]) => fact.kind === 'command-finished').length, 1)
  const utf16 = '\x1b]133;D;1234567890;\ud800a\udfff\u0000漢'
  assert.equal(api.ownRetainedString(utf16), utf16)
  const splitResults = []
  for (let cut = 1; cut < utf16.length; cut++) {
    const values = []
    const split = api.createOsc133CommandFinishedScanner((code) => values.push(code))
    split.scan(utf16.slice(0, cut))
    split.scan(`${utf16.slice(cut)}\x1b\\`)
    assert.deepEqual(values, [1234567890])
    splitResults.push(values)
  }
  return { emitted, facts, splitResults }
}

module.exports = { inputs, heap, makeOwner, behavior }
