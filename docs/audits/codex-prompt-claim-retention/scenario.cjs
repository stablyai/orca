const assert = require('node:assert/strict')

const admitted = () => ({ accepted: true })

function fixture(api) {
  const prompts = new api.CodexPromptRegistry()
  const state = { prompts, requestCount: 0, lastBinding: null, blockCompletion: false }
  const sink = {
    appendItem() {},
    appendTombstone() {},
    publish() {},
    tryAppendItem: admitted,
    tryAppendTombstone: admitted,
    tryAppendLifecycleBatch: (id) =>
      state.blockCompletion && id.startsWith('turn-completed:')
        ? { accepted: false, reason: 'backpressure' }
        : admitted(),
    tryPublish: admitted
  }
  const translator = api.createCodexJournalTranslator({
    sink,
    sessionId: 'session',
    primaryThreadId: () => 'primary',
    bindPromptItemId: (id, thread, promptKey, turn) => {
      prompts.bindJournalItemId(id, thread, promptKey, turn)
      state.lastBinding = id
    },
    clearPromptTurn: (thread, turn) => prompts.clearTurn(thread, turn)
  })
  const session = {
    threadId: 'primary',
    prompts,
    translator,
    fence: 7,
    acquisitionGeneration: 'generation',
    ended: false,
    connection: {
      request: async (method) => {
        assert.equal(method, 'turn/interrupt')
        state.requestCount++
        return {}
      },
      respondWithError() {
        throw new Error('unexpected server refusal')
      },
      respond() {
        throw new Error('unexpected prompt response')
      }
    }
  }
  const emit = (_session, event) => translator.handle(event)
  const cancellation = new api.CodexStructuredTurnCancellation({
    emit,
    captureTurnProcesses: async () => {
      throw new Error('no process enumeration allowed')
    },
    terminateTurnProcesses: async () => {
      throw new Error('no process termination allowed')
    }
  })
  cancellation.register(session)
  return Object.assign(state, {
    api,
    session,
    translator,
    cancellation,
    emit,
    sessions: new Map([['session', session]]),
    compactions: { providerTurnId: () => 'primary-turn' }
  })
}

function register(
  state,
  serial,
  thread = `child-${serial}`,
  turn = `turn-${serial}`,
  item = `item-${serial}`
) {
  state.lastBinding = null
  const admission = state.api.deliverCodexServerRequest(
    'session',
    state.session,
    {
      id: serial,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: thread, turnId: turn, itemId: item, command: 'echo bounded-proof' }
    },
    state.emit
  )
  assert.equal(admission.accepted, true)
  assert.equal(typeof state.lastBinding, 'string')
  const prompt = state.prompts.find(state.lastBinding)
  assert.ok(prompt)
  return { ref: new WeakRef(prompt), id: state.lastBinding, thread, turn }
}

async function cancel(state, record) {
  const result = await state.api.cancelCodexStructuredTurn({
    sessions: state.sessions,
    compactions: state.compactions,
    cancellation: state.cancellation,
    request: {
      sessionId: 'session',
      turnId: 'primary-turn',
      fence: 7,
      prompt: { itemId: record.id, kind: 'approval' }
    }
  })
  assert.equal(result.cancelled, true)
}

function complete(state, thread, turn, expectedAccepted = true) {
  const admission = state.api.translateCodexNotification({
    sessionId: 'session',
    session: state.session,
    method: 'turn/completed',
    params: { threadId: thread, turn: { id: turn, status: 'interrupted' } },
    turnCancellation: state.cancellation,
    emit: state.emit
  })
  assert.equal(admission.accepted, expectedAccepted)
}

async function alive(records) {
  for (let round = 0; round < 8; round++) {
    await new Promise(setImmediate)
    global.gc()
  }
  return records.filter((record) => record.ref.deref() !== undefined).length
}

async function run(api, mode) {
  const state = fixture(api)
  const ordinary = register(state, 1)
  await cancel(state, ordinary)
  assert.equal(await alive([ordinary]), 1)
  complete(state, ordinary.thread, ordinary.turn)
  const ordinaryAfterCompletion = await alive([ordinary])
  assert.equal(ordinaryAfterCompletion, 0)

  const records = []
  for (let index = 0; index < 32; index++) {
    const record = register(state, index + 10)
    await cancel(state, record)
    records.push(record)
  }
  assert.equal(await alive(records), 32)
  // Unrelated child traffic evicts old binding/address entries without ending their turns.
  for (let index = 0; index < 256; index++) {
    register(state, index + 1000, 'other-child', 'other-turn')
  }
  const sizesAfterEviction = state.prompts.sizes
  for (const record of records) {
    assert.equal(state.prompts.find(record.id), null)
  }
  const afterEvictionBeforeCompletion = await alive(records)
  assert.equal(afterEvictionBeforeCompletion, 32)
  complete(state, 'wrong-child', records[0].turn)
  complete(state, records[0].thread, 'wrong-turn')
  assert.equal(await alive(records), 32)
  register(state, 5000, records[0].thread, records[0].turn)
  state.blockCompletion = true
  complete(state, records[0].thread, records[0].turn, false)
  assert.equal(await alive(records), 32)
  state.blockCompletion = false
  for (const record of records) {
    complete(state, record.thread, record.turn)
  }
  const afterExactTurnCompletion = await alive(records)
  assert.equal(afterExactTurnCompletion, mode === 'original' ? 32 : 0)
  complete(state, 'other-child', 'other-turn')
  assert.deepEqual(state.prompts.sizes, { prompts: 0, journalBindings: 0 })
  const afterAllLookupMapsEmpty = await alive(records)
  assert.equal(afterAllLookupMapsEmpty, mode === 'original' ? 32 : 0)
  state.prompts.clear()
  const afterSessionClear = await alive(records)
  assert.equal(afterSessionClear, 0)

  // Replacing a journal address must not let old-turn completion clear the new prompt/claim.
  const old = register(state, 2000, 'reuse-child', 'old-turn', 'reused-item')
  await cancel(state, old)
  const newer = register(state, 2001, 'reuse-child', 'new-turn', 'reused-item')
  assert.equal(newer.id, old.id)
  const replacementClaim = state.prompts.claimBound(newer.id)
  assert.ok(replacementClaim)
  complete(state, old.thread, old.turn)
  assert.equal(
    state.prompts.ownsBoundClaim(replacementClaim, newer.id, newer.thread, newer.turn),
    true
  )
  const oldAfterReplacementCompletion = await alive([old])
  assert.equal(oldAfterReplacementCompletion, mode === 'original' ? 1 : 0)
  state.prompts.releaseClaim(replacementClaim)
  complete(state, newer.thread, newer.turn)
  state.prompts.clear()
  state.translator.dispose()
  return {
    ordinaryAfterCompletion,
    cancelledPrompts: 32,
    sizesAfterEviction,
    afterEvictionBeforeCompletion,
    afterExactTurnCompletion,
    afterAllLookupMapsEmpty,
    afterSessionClear,
    oldAfterReplacementCompletion,
    replacementClaimPreserved: true,
    wrongThreadPreserved: true,
    wrongTurnPreserved: true,
    rejectedCompletionPreserved: true,
    successfulInterruptRequests: state.requestCount
  }
}

module.exports = run
