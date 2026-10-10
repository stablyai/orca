const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sessionId = '11111111-1111-4111-8111-111111111111'
const nodeId = (index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`

function collect() {
  for (let index = 0; index < 5; index++) {
    global.gc()
  }
  return process.memoryUsage()
}

function writeFixture(file, count, payloadBytes) {
  const descriptor = fs.openSync(file, 'w')
  try {
    for (let index = 0; index < count; index++) {
      fs.writeSync(
        descriptor,
        `${JSON.stringify({
          type: 'user',
          uuid: nodeId(index),
          parentUuid: index === 0 ? null : nodeId(index - 1),
          sessionId,
          message: { role: 'user', content: 'x'.repeat(payloadBytes) }
        })}\n`
      )
    }
    fs.writeSync(
      descriptor,
      `${JSON.stringify({ type: 'last-prompt', sessionId, leafUuid: nodeId(count - 1) })}\n`
    )
  } finally {
    fs.closeSync(descriptor)
  }
}

async function sample(prove, file, count) {
  const before = collect()
  let peakHeap = before.heapUsed
  let peakExternal = before.external
  let records = 0
  const originalParse = JSON.parse
  JSON.parse = function (...args) {
    const row = originalParse(...args)
    records++
    const memory = collect()
    peakHeap = Math.max(peakHeap, memory.heapUsed)
    peakExternal = Math.max(peakExternal, memory.external)
    return row
  }
  let result
  try {
    result = await prove({
      transcriptPath: file,
      providerSessionId: sessionId,
      previousLeafUuid: nodeId(0)
    })
  } finally {
    JSON.parse = originalParse
  }
  assert.deepEqual(result, {
    leafUuid: nodeId(count - 1),
    relation: count === 1 ? 'same' : 'descendant'
  })
  const after = collect()
  return {
    records,
    peakHeapIncrease: peakHeap - before.heapUsed,
    peakExternalIncrease: peakExternal - before.external,
    retainedHeapIncrease: after.heapUsed - before.heapUsed,
    retainedExternalIncrease: after.external - before.external
  }
}

async function compareAllocation(scratch, modules) {
  const reports = []
  for (const [count, payloadBytes] of [
    [16, 512 * 1024],
    [64, 512 * 1024],
    [64, 0],
    [1, 8 * 1024 * 1024]
  ]) {
    const file = path.join(scratch, `allocation-${count}-${payloadBytes}.jsonl`)
    writeFixture(file, count, payloadBytes)
    const row = { count, payloadBytes, sourceBytes: fs.statSync(file).size }
    for (const [phase, methods] of Object.entries(modules)) {
      row[phase] = await sample(methods.proveClaudeTranscriptBranch, file, count)
    }
    if (count === 64 && payloadBytes > 0) {
      assert(
        row.candidate.peakHeapIncrease < row.baseline.peakHeapIncrease / 2,
        'Streaming must release prior payload rows'
      )
      assert(
        row.windowCandidate.peakHeapIncrease < row.baseline.peakHeapIncrease / 2,
        'Initial-window streaming must release prior payload rows'
      )
    }
    reports.push(row)
    fs.unlinkSync(file)
  }
  return reports
}

module.exports = { compareAllocation }
