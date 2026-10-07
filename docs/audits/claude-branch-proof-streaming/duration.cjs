const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function compareDuration(scratch, modules) {
  const count = 8192
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const id = (index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  const file = path.join(scratch, 'small-record-duration.jsonl')
  const fd = fs.openSync(file, 'w')
  try {
    for (let index = 0; index < count; index++) {
      fs.writeSync(
        fd,
        `${JSON.stringify({
          type: index % 2 === 0 ? 'user' : 'assistant',
          uuid: id(index),
          parentUuid: index === 0 ? null : id(index - 1),
          sessionId,
          message: {
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: 'Synthetic short transcript body. '.repeat(4)
          }
        })}\n`
      )
    }
    fs.writeSync(
      fd,
      `${JSON.stringify({ type: 'last-prompt', leafUuid: id(count - 1), sessionId })}\n`
    )
  } finally {
    fs.closeSync(fd)
  }
  const durations = { baseline: [], windowCandidate: [] }
  const input = { transcriptPath: file, providerSessionId: sessionId, previousLeafUuid: id(0) }
  for (let round = 0; round < 7; round++) {
    const phases =
      round % 2 === 0 ? ['baseline', 'windowCandidate'] : ['windowCandidate', 'baseline']
    for (const phase of phases) {
      const start = performance.now()
      const result = await modules[phase].proveClaudeTranscriptBranch(input)
      const elapsed = performance.now() - start
      assert.deepEqual(result, { leafUuid: id(count - 1), relation: 'descendant' })
      if (round >= 2) {
        durations[phase].push(Math.round(elapsed * 100) / 100)
      }
    }
  }
  const medians = Object.fromEntries(
    Object.entries(durations).map(([phase, values]) => [phase, values.toSorted((a, b) => a - b)[2]])
  )
  const report = {
    node: process.version,
    records: count + 1,
    sourceBytes: fs.statSync(file).size,
    method:
      'One stable real file, two warm rounds and five measured rounds, alternating phase order; no GC forced during timing. Whole proof, not an isolated parser benchmark.',
    durationsMs: durations,
    medianMs: medians
  }
  fs.unlinkSync(file)
  return report
}

module.exports = { compareDuration }
