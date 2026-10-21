const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { sessionId } = require('./parity-cases.cjs')

const rootRow = `${JSON.stringify({ type: 'user', uuid: 'root', parentUuid: null, sessionId })}\n`
const rootMarker = `${JSON.stringify({ type: 'last-prompt', leafUuid: 'root', sessionId })}\n`
const append = `${JSON.stringify({
  type: 'user',
  uuid: 'child',
  parentUuid: 'root',
  sessionId
})}\n${JSON.stringify({ type: 'last-prompt', leafUuid: 'child', sessionId })}\n`
const makeRow = (uuid, parentUuid) =>
  `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId })}\n`
const makeMarker = (leafUuid) => `${JSON.stringify({ type: 'last-prompt', leafUuid, sessionId })}\n`
function paddedSource(bytes) {
  const emptyComment = '{"comment":""}\n'
  return `${rootRow}{"comment":"${'x'.repeat(
    bytes - Buffer.byteLength(rootRow + rootMarker + emptyComment)
  )}"}\n${rootMarker}`
}

async function compareGrowth(scratch, modules) {
  const scenarios = [
    { name: 'small-regular-file', contents: rootRow + rootMarker, append },
    { name: 'exact-512k-regular-file', contents: paddedSource(512 * 1024), append },
    { name: 'nonaligned-large-regular-file', contents: paddedSource(512 * 1024 + 100), append },
    { name: 'initially-empty-file', contents: '', append: rootRow + rootMarker },
    { name: 'new-malformed-tail', contents: rootRow + rootMarker, append: '{"incomplete":' },
    { name: 'parse-error-closes-reader', contents: `{"broken":\n${rootRow}${rootMarker}` },
    { name: 'empty-file-closes-reader', contents: '' },
    { name: 'read-error-closes-reader', contents: rootRow + rootMarker, readError: true },
    { name: 'stat-error-closes-reader', contents: rootRow + rootMarker, statError: true },
    {
      name: 'restat-failure-keeps-missing-marker',
      contents: rootRow,
      append: rootMarker,
      restatError: true
    },
    { name: 'replacement-cannot-prove-original-growth', contents: rootRow, replace: true },
    { name: 'shrink-cannot-prove-growth', contents: `${rootRow} \n`, truncate: 0 },
    {
      name: 'growth-preserves-conflict',
      contents: rootRow + makeRow('root', 'other') + rootMarker,
      append
    },
    {
      name: 'growth-preserves-wrong-session',
      contents: `${rootRow + JSON.stringify({ type: 'last-prompt', sessionId: 'foreign', leafUuid: 'root' })}\n`,
      append
    },
    {
      name: 'growth-preserves-append-order',
      contents: makeRow('child', 'root') + rootRow + makeMarker('child'),
      append
    },
    { name: 'path-replacement-keeps-opened-file', contents: rootRow + rootMarker, replace: true },
    { name: 'path-deletion-keeps-opened-file', contents: rootRow + rootMarker, delete: true },
    {
      name: 'truncation-leaves-complete-prefix',
      contents: rootRow + rootMarker + append,
      truncate: Buffer.byteLength(rootRow + rootMarker)
    },
    {
      name: 'truncation-leaves-torn-tail',
      contents: paddedSource(1024),
      truncate: Buffer.byteLength(rootRow) + 8
    },
    {
      name: 'prefix-descendant-under-growth',
      contents: rootRow + append,
      append: makeRow('grandchild', 'child') + makeMarker('grandchild'),
      options: { previousLeafUuid: 'root' }
    },
    {
      name: 'prefix-rewind-under-growth',
      contents: rootRow + makeRow('kept', 'root') + makeRow('old', 'kept') + makeMarker('kept'),
      append: makeMarker('old'),
      options: { previousLeafUuid: 'old', intentionalRewindUuid: 'kept' }
    },
    {
      name: 'missing-previous-repaired-by-growth',
      contents: rootRow + rootMarker,
      append,
      options: { previousLeafUuid: 'child' }
    },
    { name: 'missing-marker-repaired-by-growth', contents: rootRow, append: rootMarker },
    {
      name: 'torn-prefix-repaired-by-growth',
      contents: rootRow + rootMarker.slice(0, -2),
      append: '}\n'
    }
  ]
  const reports = []
  for (const scenario of scenarios) {
    const phases = {}
    for (const [phase, methods] of Object.entries(modules)) {
      const file = path.join(scratch, `growth-${phase}.jsonl`)
      fs.writeFileSync(file, scenario.contents)
      const binding = process.binding('fs')
      const originalOpen = fsPromises.open
      let openedHandle
      fsPromises.open = async function (...args) {
        const handle = await originalOpen.apply(this, args)
        if (args[0] === file) {
          openedHandle = handle
        }
        return handle
      }
      const originalRead = binding.read
      const originalFstat = binding.fstat
      const originalCreateReadStream = fs.createReadStream
      let streamClosed = Promise.resolve()
      fs.createReadStream = function (...args) {
        const stream = originalCreateReadStream.apply(this, args)
        streamClosed = new Promise((resolve) => stream.once('close', resolve))
        return stream
      }
      let descriptor
      let descriptorIdentity
      let injected = false
      let statsRead = 0
      function inject(fd) {
        if (!injected) {
          injected = true
          descriptor = fd
          descriptorIdentity = fs.fstatSync(fd)
          if (scenario.append) {
            fs.appendFileSync(file, scenario.append)
          }
          if (scenario.replace) {
            fs.renameSync(file, `${file}.opened`)
            fs.writeFileSync(file, rootRow + append)
          }
          if (scenario.delete) {
            fs.unlinkSync(file)
          }
          if (scenario.truncate !== undefined) {
            fs.truncateSync(file, scenario.truncate)
          }
        }
      }
      binding.fstat = function (...args) {
        const result = originalFstat.apply(this, args)
        if (typeof result?.then !== 'function') {
          return result
        }
        return result.then((stats) => {
          inject(args[0])
          statsRead++
          if (scenario.statError || (scenario.restatError && statsRead > 1)) {
            throw Object.assign(new Error('Synthetic stat failure after actual open'), {
              code: 'EIO'
            })
          }
          return stats
        })
      }
      binding.read = function (...args) {
        inject(args[0])
        if (scenario.readError) {
          const error = Object.assign(new Error('Synthetic read failure after actual open'), {
            code: 'EIO'
          })
          const request = args.at(-1)
          if (typeof request?.oncomplete === 'function') {
            queueMicrotask(() => request.oncomplete(error))
            return
          }
          return Promise.reject(error)
        }
        return originalRead.apply(this, args)
      }
      let outcome
      try {
        outcome = {
          status: 'fulfilled',
          value: await methods.proveClaudeTranscriptBranch({
            transcriptPath: file,
            providerSessionId: sessionId,
            previousLeafUuid: null,
            ...scenario.options
          })
        }
      } catch (error) {
        outcome = {
          status: 'rejected',
          name: error.name,
          message: error.message,
          ...(error.code ? { code: error.code } : {})
        }
      } finally {
        fsPromises.open = originalOpen
        binding.read = originalRead
        binding.fstat = originalFstat
        fs.createReadStream = originalCreateReadStream
      }
      function isOriginalDescriptorClosed() {
        if (openedHandle) {
          return openedHandle.fd === -1
        }
        try {
          const current = fs.fstatSync(descriptor)
          return current.dev !== descriptorIdentity.dev || current.ino !== descriptorIdentity.ino
        } catch (error) {
          return error.code === 'EBADF'
        }
      }
      const descriptorClosedAtReturn = isOriginalDescriptorClosed()
      await streamClosed
      const descriptorClosed = isOriginalDescriptorClosed()
      assert(injected, 'Actual file read must reach deterministic injection point')
      assert(descriptorClosed, `${scenario.name}/${phase} leaked its actual file descriptor`)
      if (phase === 'windowCandidate') {
        assert(descriptorClosedAtReturn)
      }
      phases[phase] = { outcome, descriptorClosedAtReturn, descriptorClosed }
      if (!scenario.delete) {
        fs.unlinkSync(file)
      }
      if (scenario.replace) {
        fs.unlinkSync(`${file}.opened`)
      }
    }
    if (scenario.name === 'small-regular-file' || scenario.name === 'exact-512k-regular-file') {
      assert.equal(phases.baseline.outcome.value.leafUuid, 'root')
      assert.equal(phases.candidate.outcome.value.leafUuid, 'child')
    } else if (scenario.name === 'new-malformed-tail') {
      assert.equal(phases.baseline.outcome.status, 'fulfilled')
      assert.equal(phases.candidate.outcome.name, 'ClaudeTranscriptTailIncompleteError')
    } else if (
      !scenario.options &&
      !scenario.name.includes('repaired-by-growth') &&
      !scenario.statError &&
      !scenario.restatError
    ) {
      assert.deepEqual(phases.baseline.outcome, phases.candidate.outcome, scenario.name)
    }
    if (
      [
        'initially-empty-file',
        'missing-previous-repaired-by-growth',
        'missing-marker-repaired-by-growth',
        'torn-prefix-repaired-by-growth'
      ].includes(scenario.name)
    ) {
      assert.equal(phases.windowCandidate.outcome.status, 'fulfilled', scenario.name)
      assert.equal(
        phases.windowCandidate.outcome.value.leafUuid,
        scenario.name === 'missing-previous-repaired-by-growth' ? 'child' : 'root'
      )
    } else if (
      [
        'small-regular-file',
        'exact-512k-regular-file',
        'nonaligned-large-regular-file',
        'new-malformed-tail'
      ].includes(scenario.name)
    ) {
      assert.equal(phases.windowCandidate.outcome.value.leafUuid, 'root')
    } else {
      assert.deepEqual(phases.windowCandidate.outcome, phases.baseline.outcome)
    }
    if (scenario.name === 'prefix-descendant-under-growth') {
      assert.deepEqual(phases.windowCandidate.outcome.value, {
        leafUuid: 'child',
        relation: 'descendant'
      })
    }
    if (scenario.name === 'prefix-rewind-under-growth') {
      assert.deepEqual(phases.windowCandidate.outcome.value, {
        leafUuid: 'kept',
        relation: 'intentional-rewind'
      })
    }
    reports.push({
      name: scenario.name,
      initialBytes: Buffer.byteLength(scenario.contents),
      appendedBytes: Buffer.byteLength(scenario.append ?? ''),
      phases
    })
  }
  return {
    node: process.version,
    method:
      'Append after native stat captures size; open-ended stream has no stat, so append before its first native read. Real files and actual proof methods.',
    reports
  }
}

module.exports = { compareGrowth }
