import assert from 'node:assert/strict'

function block(type, callId, reads) {
  const value =
    type === 'tool-call'
      ? { type, name: 'Bash', input: { command: `echo ${callId}` } }
      : { type, output: `stdout ${callId}\n${'x'.repeat(1024)}` }
  if (reads) {
    Object.defineProperty(value, 'callId', {
      enumerable: true,
      get() {
        reads.count += 1
        return callId
      }
    })
  } else {
    value.callId = callId
  }
  return Object.freeze(value)
}

export function createFoldWorkloads(count, reads) {
  const call = (id) => block('tool-call', id, reads)
  const result = (id) => block('tool-result', id, reads)
  const named = Array.from({ length: count }, (_, index) => call(`call-${index}`))
  const answers = Array.from({ length: count }, (_, index) => result(`call-${index}`))
  const orphans = Array.from({ length: count }, (_, index) => result(`unknown-${index}`))
  const rows = (entries) =>
    Object.freeze(
      entries.map(([role, blocks], index) =>
        Object.freeze({
          id: `row-${index}`,
          role,
          blocks: Object.freeze(blocks),
          timestamp: index,
          source: 'transcript',
          journalPosition: Object.freeze({ sequence: index + 1, index: 0 })
        })
      )
    )
  return [
    {
      name: 'immediate-pairs',
      messages: rows([
        ['assistant', [{ type: 'text', text: 'Running commands' }]],
        ...named.flatMap((entry, index) => [
          ['tool', [entry]],
          ['tool', [answers[index]]]
        ])
      ])
    },
    {
      name: 'reverse-results',
      messages: rows([
        ['assistant', named],
        ...answers.toReversed().map((entry) => ['tool', [entry]])
      ])
    },
    {
      name: 'silent-call-backlog',
      messages: rows([
        ['assistant', named],
        ...named.flatMap((_, index) => [
          ['tool', [call(`later-${index}`)]],
          ['tool', [result(`later-${index}`)]]
        ])
      ])
    },
    { name: 'named-orphans-batch', messages: rows([['tool', orphans]]) },
    {
      name: 'named-orphans-singletons',
      messages: rows([['assistant', named], ...orphans.map((entry) => ['tool', [entry]])])
    },
    {
      name: 'leading-results-before-calls',
      messages: rows([
        ['user', [{ type: 'text', text: 'Continue' }]],
        ...answers.map((entry) => ['tool', [entry]]),
        ['assistant', named]
      ])
    }
  ]
}

export function summarizeFoldOutput(messages) {
  const blocks = messages.flatMap((message) => message.blocks)
  return {
    rows: messages.length,
    calls: blocks.filter((entry) => entry.type === 'tool-call').length,
    results: blocks.filter((entry) => entry.type === 'tool-result').length,
    standaloneRows: messages.filter((entry) => entry.unpairedToolResults === true).length
  }
}

export function assertFoldConservesEvidence(input, output) {
  const before = input.flatMap((message) => message.blocks)
  const after = output.flatMap((message) => message.blocks)
  for (const type of ['tool-call', 'tool-result']) {
    assert.deepEqual(
      new Set(after.filter((entry) => entry.type === type)),
      new Set(before.filter((entry) => entry.type === type))
    )
  }
  assert.equal(new Set(output.map((message) => message.id)).size, output.length)
}

export function countFoldOperations(run, messages, reads) {
  const known = new Set(messages.flatMap((message) => message.blocks))
  const push = Array.prototype.push
  let pairWrappers = 0
  const startReads = reads.count
  Array.prototype.push = function (...items) {
    for (const item of items) {
      if (
        item !== null &&
        typeof item === 'object' &&
        (('call' in item && known.has(item.call)) || ('result' in item && known.has(item.result)))
      ) {
        pairWrappers += 1
      }
    }
    return push.apply(this, items)
  }
  let output
  try {
    output = run(messages)
  } finally {
    Array.prototype.push = push
  }
  return { pairWrappers, callIdReads: reads.count - startReads, output }
}
