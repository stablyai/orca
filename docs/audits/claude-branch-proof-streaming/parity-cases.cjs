const sessionId = 'synthetic-provider'
const row = (uuid, parentUuid, extra = {}) => ({
  type: 'user',
  uuid,
  parentUuid,
  sessionId,
  ...extra
})
const marker = (leafUuid, extra = {}) => ({ type: 'last-prompt', sessionId, leafUuid, ...extra })
const jsonl = (rows, trailing = true) =>
  rows.map((item) => JSON.stringify(item)).join('\n') + (trailing ? '\n' : '')
const graph = [row('root', null), row('kept', 'root'), row('old', 'kept')]

function parityCases() {
  const cases = []
  const add = (name, contents, options = {}, error = null) =>
    cases.push({ name, contents, options, error })
  const good = jsonl([...graph, marker('old')])
  add('initial', good)
  add('same', good, { previousLeafUuid: 'old' })
  add('descendant', good, { previousLeafUuid: 'root' })
  add('valid-unterminated-tail', good.trimEnd())
  add('blank-lines-crlf', `\r\n  \r\n${good.replaceAll('\n', '\r\n')}\r\n`)
  add('torn-tail', `${good}{"type":`, {}, 'ClaudeTranscriptTailIncompleteError')
  add('terminated-malformed-tail', `${good}{"type":\n`, {}, 'Error')
  add('malformed-middle', `{"type":\n${good}`, {}, 'Error')
  add('malformed-before-blank-tail', `${good}{"type":\n `, {}, 'Error')
  add('non-object-null', `null\n${good}`, {}, 'Error')
  add('non-object-array', `[]\n${good}`, {}, 'Error')
  add('missing-marker', jsonl(graph), {}, 'Error')
  add('marker-before-leaf', jsonl([marker('old'), ...graph]), {}, 'Error')
  add(
    'wrong-marker-session',
    jsonl([...graph, marker('old', { sessionId: 'foreign' })]),
    {},
    'Error'
  )
  add('empty-marker-leaf', jsonl([...graph, marker('')]), {}, 'Error')
  add('missing-marker-leaf', jsonl([...graph, marker('absent')]), {}, 'Error')
  add('last-marker-wins', jsonl([...graph, marker('root'), marker('old')]), {
    previousLeafUuid: 'root'
  })
  add(
    'last-marker-sibling',
    jsonl([...graph, row('sibling', 'root'), marker('old'), marker('sibling')]),
    { previousLeafUuid: 'old' },
    'Error'
  )
  add('duplicate-identical-after-marker', good + jsonl([row('old', 'kept')]))
  for (const { name, extra } of [
    { name: 'parent', extra: { parentUuid: 'root' } },
    { name: 'session', extra: { sessionId: 'foreign' } },
    { name: 'sidechain', extra: { isSidechain: true } }
  ]) {
    add(`duplicate-conflicting-${name}`, good + jsonl([row('old', 'kept', extra)]), {}, 'Error')
  }
  add(
    'append-order-on-proof-path',
    jsonl([graph[1], graph[0], graph[2], marker('old')]),
    {},
    'Error'
  )
  add(
    'append-order-outside-proof-path',
    good +
      jsonl([row('disconnected-child', 'disconnected-parent'), row('disconnected-parent', null)]),
    {},
    'Error'
  )
  add('missing-old-ancestor', jsonl([...graph.slice(1), marker('old')]), {}, 'Error')
  add('cycle', jsonl([row('root', 'old'), ...graph.slice(1), marker('old')]), {}, 'Error')
  add(
    'missing-previous-cursor',
    good,
    { previousLeafUuid: 'absent' },
    'ClaudeTranscriptPreviousCursorMissingError'
  )
  add(
    'previous-foreign-session',
    jsonl([row('root', null, { sessionId: 'foreign' }), ...graph.slice(1), marker('old')]),
    { previousLeafUuid: 'root' },
    'Error'
  )
  for (const { name, extra } of [
    { name: 'sidechain', extra: { isSidechain: true } },
    { name: 'parent-tool', extra: { parent_tool_use_id: 'tool' } },
    { name: 'result', extra: { type: 'result' } },
    { name: 'stream', extra: { type: 'stream_event' } },
    { name: 'init', extra: { type: 'system', subtype: 'init' } }
  ]) {
    add(
      `disallowed-leaf-${name}`,
      jsonl([...graph.slice(0, 2), row('old', 'kept', extra), marker('old')]),
      {},
      'Error'
    )
    add(
      `disallowed-old-ancestor-${name}`,
      jsonl([row('root', null, extra), ...graph.slice(1), marker('old')]),
      {},
      'Error'
    )
  }
  add('rewind', jsonl([...graph, marker('kept')]), {
    previousLeafUuid: 'old',
    intentionalRewindUuid: 'kept'
  })
  add(
    'rewind-without-intent',
    jsonl([...graph, marker('kept')]),
    { previousLeafUuid: 'old' },
    'Error'
  )
  add(
    'rewind-wrong-target',
    jsonl([...graph, marker('kept')]),
    { previousLeafUuid: 'old', intentionalRewindUuid: 'root' },
    'Error'
  )
  add(
    'rewind-no-previous',
    jsonl([...graph, marker('kept')]),
    { intentionalRewindUuid: 'kept' },
    'Error'
  )
  add('rewind-to-same', good, { previousLeafUuid: 'old', intentionalRewindUuid: 'old' }, 'Error')
  add(
    'rewind-to-sibling',
    jsonl([...graph, row('sibling', 'root'), marker('sibling')]),
    { previousLeafUuid: 'old', intentionalRewindUuid: 'sibling' },
    'Error'
  )
  add(
    'old-ancestor-before-large-body',
    jsonl([
      graph[0],
      row('kept', 'root', { message: 'x'.repeat(3 * 1024 * 1024) }),
      graph[2],
      marker('old')
    ]),
    { previousLeafUuid: 'root' }
  )
  const unicode = row('root', null, { message: '' })
  const messageOffset = JSON.stringify(unicode).indexOf('"message":"') + '"message":"'.length
  unicode.message = `${'x'.repeat(65535 - messageOffset)}🙂é漢字`
  add('utf8-crosses-64k-file-chunk', jsonl([unicode, ...graph.slice(1), marker('old')]))
  add('unicode-identities', jsonl([row('起🙂', null), row('終é', '起🙂'), marker('終é')]), {
    previousLeafUuid: '起🙂'
  })
  add(
    'invalid-utf8-replacement-in-message',
    Buffer.concat([
      Buffer.from(jsonl(graph)),
      Buffer.from('{"comment":"'),
      Buffer.from([0xf0, 0x80, 0x80]),
      Buffer.from(`"}\n${jsonl([marker('old')])}`)
    ])
  )
  add(
    'invalid-utf8-in-torn-tail',
    Buffer.concat([Buffer.from(`${good}{"comment":"`), Buffer.from([0xf0, 0x9f])]),
    {},
    'ClaudeTranscriptTailIncompleteError'
  )
  for (const count of [10_000, 10_001]) {
    const rows = Array.from({ length: count }, (_, index) =>
      row(`depth-${index}`, index === 0 ? null : `depth-${index - 1}`)
    )
    add(
      `ancestry-depth-${count}`,
      jsonl([...rows, marker(`depth-${count - 1}`)]),
      {},
      count === 10_001 ? 'Error' : null
    )
  }
  return cases
}

module.exports = { parityCases, sessionId }
