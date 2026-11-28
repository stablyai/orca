// Scripted stand-in for the zcode CLI used by ZcodeChatSession tests. It answers one prompt with a
// stream-json turn, echoing the `--resume` id it was given, and omits the terminal `result` for the
// prompt `NO-RESULT` so the incomplete-turn path can be exercised.

const args = process.argv.slice(2)
const promptIndex = args.indexOf('-p')
const prompt = promptIndex !== -1 ? (args[promptIndex + 1] ?? '') : ''
const resumeIndex = args.indexOf('--resume')
const resumed = resumeIndex !== -1 ? args[resumeIndex + 1] : null
const sessionId = resumed ?? 'sess_scripted_1'

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)

write({ type: 'turn.started', sessionId })
write({
  type: 'model.streaming',
  sessionId,
  payload: { kind: 'text_delta', delta: `[resume=${sessionId}] OK` }
})
write({ type: 'turn.completed', sessionId, payload: { content: 'OK' } })
if (prompt !== 'NO-RESULT') {
  write({
    type: 'result',
    sessionId,
    response: 'OK',
    eventCount: 4,
    projection: { status: 'idle' }
  })
}
