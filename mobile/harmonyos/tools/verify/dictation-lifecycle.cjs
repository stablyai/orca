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
