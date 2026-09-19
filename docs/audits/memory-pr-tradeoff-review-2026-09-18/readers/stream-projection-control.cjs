const assert = require('node:assert/strict')
const { JSONParser } = require('@streamparser/json')
const scalarBytes = 12 * 1024 * 1024
const rows = []
for (const emitPartialTokens of [false, true]) {
  const parser = new JSONParser({
    paths: ['$.keep'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
    emitPartialTokens
  })
  const values = []
  parser.onValue = ({ value }) => values.push(value)
  parser.write('{"ignored":"')
  const chunk = 'x'.repeat(64 * 1024)
  for (let i = 0; i < scalarBytes / chunk.length; i++) parser.write(chunk)
  const retainedScalarBytes = parser.tokenizer.bufferedString.byteLength
  assert.equal(retainedScalarBytes, scalarBytes)
  assert.equal(parser.tokenizer.bufferedString.toString().length, scalarBytes)
  parser.write('","keep":7}')
  assert.deepEqual(values, [7])
  rows.push({ emitPartialTokens, scalarBytes, retainedScalarBytes, selectedValues: values })
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      purpose:
        'Path projection and partial-token emission do not discard an ignored giant scalar; this does not rule out a deeper parser redesign.',
      rows
    },
    null,
    2
  )
)
