const assert = require('node:assert/strict')
const { load } = require('./sources.cjs')

async function scenario(phase) {
  const readers = []
  globalThis.__orcaEmptyDeltaReaders = readers
  const {
    createCodexStructuredItemStreams,
    createAgentSessionDeltaCoalescer,
    sourceSha256,
    bundleSha256
  } = await load(phase)
  const fixed = phase === 'fixed' || phase === 'reportedFixed'
  let scheduled = 0
  let published = 0
  const publications = []
  const streams = createCodexStructuredItemStreams({
    sink: {
      appendItem(identity, body) {
        published += 1
        publications.push({ identity, body })
      },
      publish() {}
    },
    identityFor: () => ({ provider: 'codex', threadId: 'thread-a', turnId: 'turn-a', ordinal: 0 }),
    schedule: () => {
      scheduled += 1
      return () => {}
    }
  })
  assert.equal(readers.length, 1)
  const read = readers[0]
  const samples = []
  for (let batch = 0; batch < 4; batch += 1) {
    for (let index = 0; index < 16384; index += 1) {
      assert.deepEqual(
        streams.handle('thread-a', 'item/agentMessage/delta', { itemId: 'item-a', delta: '' }),
        { handled: true, admission: { accepted: true } }
      )
    }
    assert.equal(streams.flush(), true)
    samples.push(read())
    assert.deepEqual(streams.snapshot('thread-a', 'item-a'), {
      text: '',
      observedBytes: 0,
      truncated: false
    })
  }
  assert.equal(read().slots, fixed ? 0 : 65536)
  assert.equal(read().retainedBytes, 0)
  assert.equal(read().observedBytes, 0)
  streams.handle('thread-a', 'item/agentMessage/delta', { itemId: 'item-a', delta: 'hé' })
  assert.equal(streams.flush(), true)
  assert.deepEqual(streams.snapshot('thread-a', 'item-a'), {
    text: 'hé',
    observedBytes: 3,
    truncated: false
  })
  assert.equal(read().slots, fixed ? 1 : 65537)
  streams.forget('thread-a', 'item-a')
  assert.deepEqual(read(), { streams: 0, slots: 0, retainedBytes: 0, observedBytes: 0 })
  streams.handle('thread-a', 'item/agentMessage/delta', {
    itemId: 'item-a',
    delta: 'retained until dispose'
  })
  streams.dispose()
  assert.deepEqual(read(), { streams: 0, slots: 0, retainedBytes: 0, observedBytes: 0 })

  let accepting = false
  const pending = new Set()
  const emitted = []
  let directScheduled = 0
  const deps = {
    emit(key, text, snapshot) {
      assert.equal(this, deps)
      if (!accepting) {
        return false
      }
      emitted.push({ key, text, snapshot })
      return true
    },
    schedule(run) {
      directScheduled += 1
      pending.add(run)
      return () => pending.delete(run)
    },
    maxStreams: 1,
    maxRetainedBytes: 64,
    maxTotalRetainedBytes: 64
  }
  const direct = createAgentSessionDeltaCoalescer(deps)
  assert.equal(direct.append('one', ''), true)
  assert.deepEqual(direct.snapshot('one'), { text: '', observedBytes: 0, truncated: false })
  assert.equal(pending.size, 1)
  assert.equal(direct.flushAll(), false)
  assert.equal(pending.size, 1)
  assert.equal(direct.append('two', ''), false)
  assert.equal(direct.snapshot('two'), null)
  accepting = true
  assert.equal(direct.flushAll(), true)
  assert.equal(pending.size, 0)
  assert.equal(direct.append('one', ''), true)
  assert.equal(direct.flushAll(), true)
  assert.equal(emitted.length, 2)
  assert.equal(direct.append('one', 'unchanged'), true)
  assert.equal(direct.flushAll(), true)
  accepting = false
  direct.append('one', '')
  assert.equal(direct.append('two', ''), false)
  assert.deepEqual(direct.snapshot('one'), {
    text: 'unchanged',
    observedBytes: 9,
    truncated: false
  })
  accepting = true
  assert.equal(direct.append('two', ''), true)
  assert.equal(direct.snapshot('one'), null)
  assert.equal(direct.flushAll(), true)
  direct.append('two', '😀'.repeat(100))
  assert.equal(direct.flushAll(), true)
  const truncated = direct.snapshot('two')
  assert.ok(Buffer.byteLength(truncated.text, 'utf8') <= 64)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.observedBytes, 400)
  const publicationsBeforeEmpty = emitted.length
  direct.append('two', '')
  assert.equal(direct.flushAll(), true)
  assert.equal(emitted.length, publicationsBeforeEmpty)
  assert.deepEqual(direct.snapshot('two'), truncated)
  direct.dispose()
  assert.equal(pending.size, 0)
  assert.deepEqual(readers[1](), { streams: 0, slots: 0, retainedBytes: 0, observedBytes: 0 })
  delete globalThis.__orcaEmptyDeltaReaders
  return {
    sourceSha256,
    bundleSha256,
    samples,
    behavior: { scheduled, published, publications, directScheduled, emitted, truncated },
    controls: [
      'actual Codex empty notification stream',
      'empty snapshot remains present',
      'four explicit flushes',
      'Unicode text retained',
      'forget clears',
      'dispose clears',
      'first empty publication and retries',
      'emit receiver preserved',
      'new empty key rejected under backpressure',
      'accepted eviction',
      'UTF-8 truncation',
      'already-truncated empty append keeps no-new-publication behavior'
    ]
  }
}

module.exports = { scenario }
