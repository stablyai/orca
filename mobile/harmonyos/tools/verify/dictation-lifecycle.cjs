const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts, util } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')

test('leaving during microphone permission cannot start a late dictation capture', async () => {
  let grant
  const permission = new Promise((resolve) => {
    grant = resolve
  })
  const peer = createRpcPeer()
  const capturer = {
    on() {},
    off() {},
    start: async () => {},
    stop: async () => {},
    release: async () => {}
  }
  const audio = {
    AudioSamplingRate: {},
    AudioChannel: {},
    AudioSampleFormat: {},
    AudioEncodingType: {},
    SourceType: {},
    createAudioCapturer: async () => capturer
  }
  const { DictationController } = loadArkts(
    'dictation/DictationController.ets',
    ['DictationController'],
    {
      ...peer,
      util,
      audio,
      abilityAccessCtrl: {
        createAtManager: () => ({ requestPermissionsFromUser: () => permission })
      }
    }
  )
  const controller = new DictationController({}, () => {})
  const rpc = { request: async () => new peer.RpcSuccess('test', '{}') }
  const starting = controller.start('pending-dictation', rpc)
  await controller.stop()
  grant({ authResults: [0] })
  assert.equal(await starting, false)
  assert.equal(controller.isRunning(), false)
})

for (const failure of ['off', 'stop']) {
  test(`dictation releases its native capturer when ${failure} fails during shutdown`, async () => {
    let open = false
    const peer = createRpcPeer()
    const capturer = {
      on() {},
      off() {
        if (failure === 'off') {
          throw new Error('Listener removal failed')
        }
      },
      async start() {
        open = true
      },
      async stop() {
        if (failure === 'stop') {
          throw new Error('Capture stop failed')
        }
      },
      async release() {
        open = false
      }
    }
    const { DictationController } = loadArkts(
      'dictation/DictationController.ets',
      ['DictationController'],
      {
        ...peer,
        util,
        audio: {
          AudioSamplingRate: {},
          AudioChannel: {},
          AudioSampleFormat: {},
          AudioEncodingType: {},
          SourceType: {},
          createAudioCapturer: async () => capturer
        },
        abilityAccessCtrl: {
          createAtManager: () => ({
            requestPermissionsFromUser: async () => ({ authResults: [0] })
          })
        }
      }
    )
    const controller = new DictationController({}, () => {})
    const rpc = { request: async () => new peer.RpcSuccess('test', '{}') }
    assert.equal(await controller.start('release-fixture', rpc), true)
    await controller.stop()
    assert.equal(open, false)
  })
}
