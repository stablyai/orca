const assert = require('node:assert/strict')
const { getEventListeners } = require('node:events')

const fixtureKey = '__orcaWorkingDirectoryWaitFixture'
const validDirectory = { isDirectory: () => true }
async function collect() {
  for (let round = 0; round < 6; round++) {
    await new Promise(setImmediate)
    global.gc()
  }
}
const tick = async (count) => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function canceledWait(validation, cwd) {
  const controller = new AbortController()
  const options = { signal: controller.signal }
  const refs = { signal: new WeakRef(controller.signal), options: new WeakRef(options) }
  const waiting = validation.validateWorkingDirectoryAsync(cwd, options)
  controller.abort()
  await assert.rejects(waiting, (error) => {
    refs.error = new WeakRef(error)
    return error instanceof validation.WorkingDirectoryValidationAbortedError
  })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  return refs
}
const counts = (refs) =>
  Object.fromEntries(
    ['signal', 'options', 'error'].map((key) => [
      key,
      refs.filter((ref) => ref[key].deref()).length
    ])
  )

async function lifetime(validation, fixed, reject) {
  const gate = Promise.withResolvers()
  let statCalls = 0
  globalThis[fixtureKey] = {
    stat() {
      statCalls++
      return gate.promise
    }
  }
  const cwd = `synthetic-validation-${reject}`
  const refs = []
  for (let index = 0; index < 32; index++) {
    refs.push(await canceledWait(validation, cwd))
  }
  await collect()
  const beforeSettlement = counts(refs)
  assert.equal(statCalls, 1)
  assert.equal(beforeSettlement.options, 0)
  assert.equal(beforeSettlement.signal, fixed ? 0 : 32)
  if (fixed) {
    assert.equal(beforeSettlement.error, 0)
  }
  const controller = new AbortController()
  const late = validation.validateWorkingDirectoryAsync(cwd, { signal: controller.signal }).then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', message: error.message })
  )
  assert.equal(statCalls, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  if (reject) {
    gate.reject(new Error('synthetic native failure'))
  } else {
    gate.resolve(validDirectory)
  }
  const lateResult = await late
  assert.equal(lateResult.status, reject ? 'rejected' : 'fulfilled')
  await collect()
  const afterSettlement = counts(refs)
  assert.deepEqual(afterSettlement, { signal: 0, options: 0, error: 0 })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  globalThis[fixtureKey] = {
    stat() {
      statCalls++
      return Promise.resolve(validDirectory)
    }
  }
  await validation.validateWorkingDirectoryAsync(cwd)
  assert.equal(statCalls, 2)
  return {
    beforeSettlement,
    afterSettlement,
    nativeCallsBeforeSettlement: 1,
    nativeCallsAfterFreshValidation: statCalls,
    lateResult
  }
}

async function laneOwnership(validation) {
  const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()]
  const started = []
  globalThis[fixtureKey] = {
    stat(cwd) {
      started.push(cwd)
      return gates[started.length - 1].promise
    }
  }
  const paths = Array.from({ length: 3 }, (_, index) => `\\\\synthetic-host\\dir-${index}`)
  for (const cwd of paths) {
    await canceledWait(validation, cwd)
  }
  await tick(8)
  assert.equal(started.length, 2)
  gates[0].resolve(validDirectory)
  await new Promise(setImmediate)
  assert.equal(started.length, 3)
  gates[1].resolve(validDirectory)
  gates[2].resolve(validDirectory)
  await new Promise(setImmediate)
  return {
    canceledWaits: 3,
    nativeCallsWhileBothSlotsOwned: 2,
    nativeCallsAfterOneRawCompletion: 3
  }
}

async function ordering(validation, reject, startedBefore, ticks, abortFirst) {
  const gate = Promise.withResolvers()
  let calls = 0
  globalThis[fixtureKey] = {
    stat() {
      calls++
      return calls === 1 ? gate.promise : Promise.resolve(validDirectory)
    }
  }
  const cwd = `matrix-${reject}-${startedBefore}-${ticks}-${abortFirst}`
  const anchor = validation.validateWorkingDirectoryAsync(cwd).catch(() => {})
  const controller = new AbortController()
  const start = () =>
    validation.validateWorkingDirectoryAsync(cwd, { signal: controller.signal }).then(
      () => ['fulfilled'],
      (error) => ['rejected', error.name, error.message]
    )
  let waiting = startedBefore ? start() : null
  const settle = () =>
    reject ? gate.reject(new Error('raw failure')) : gate.resolve(validDirectory)
  if (abortFirst) {
    controller.abort()
  } else {
    settle()
  }
  await tick(ticks)
  waiting ??= start()
  if (abortFirst) {
    settle()
  } else {
    controller.abort()
  }
  const outcome = await waiting
  await anchor
  await new Promise(setImmediate)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  return { outcome, calls }
}

async function observerOrdering(validation, position, reject) {
  const gate = Promise.withResolvers()
  globalThis[fixtureKey] = { stat: () => gate.promise }
  const cwd = `observer-${position}-${reject}`
  const raw = validation.validateWorkingDirectoryAsync(cwd)
  const controller = new AbortController()
  const start = () =>
    validation.validateWorkingDirectoryAsync(cwd, { signal: controller.signal }).then(
      () => ['fulfilled'],
      (error) => ['rejected', error.name]
    )
  const waiting = []
  if (position !== 'before') {
    waiting.push(start())
  }
  const abortObserver = raw.then(
    () => controller.abort(),
    () => controller.abort()
  )
  if (position !== 'after') {
    waiting.push(start())
  }
  if (reject) {
    gate.reject(new Error('raw failure'))
  } else {
    gate.resolve(validDirectory)
  }
  const outcomes = await Promise.all(waiting)
  await abortObserver
  return outcomes
}

async function alreadyAborted(validation) {
  const gate = Promise.withResolvers()
  let nativeCalls = 0
  globalThis[fixtureKey] = {
    stat() {
      nativeCalls++
      return gate.promise
    }
  }
  const signal = AbortSignal.abort()
  await assert.rejects(
    validation.validateWorkingDirectoryAsync('pre-aborted', { signal }),
    (error) => error instanceof validation.WorkingDirectoryValidationAbortedError
  )
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  const raw = validation.validateWorkingDirectoryAsync('pre-aborted')
  assert.equal(validation.validateWorkingDirectoryAsync('pre-aborted'), raw)
  assert.equal(nativeCalls, 1)
  gate.resolve(validDirectory)
  await raw
  return { nativeCalls, noSignalPromiseIdentityPreserved: true }
}

async function canceledNativeRejection(validation) {
  const gate = Promise.withResolvers()
  globalThis[fixtureKey] = { stat: () => gate.promise }
  await canceledWait(validation, 'late-native-rejection')
  gate.reject(new Error('Native failure after all callers canceled'))
  await new Promise(setImmediate)
  return { nativeRejectedAfterCallerCanceled: true }
}

module.exports = {
  fixtureKey,
  lifetime,
  laneOwnership,
  ordering,
  observerOrdering,
  alreadyAborted,
  canceledNativeRejection
}
