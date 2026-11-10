const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')
const { readHomeStats, totalHomeStats } = loadArkts('home/HomeStats.ets', [
  'readHomeStats',
  'totalHomeStats'
])

test('home totals omit removed desktops and refuse an unanswered empty summary', () => {
  assert.equal(readHomeStats('{}'), null)
  const one = readHomeStats('{"totalAgentsSpawned":2,"totalPRsCreated":3,"totalAgentTimeMs":60000}')
  const removed = readHomeStats(
    '{"totalAgentsSpawned":99,"totalPRsCreated":99,"totalAgentTimeMs":99}'
  )
  const total = totalHomeStats({ one, removed }, ['one'])
  assert.equal(total.totalAgentsSpawned, 2)
  assert.equal(total.totalPRsCreated, 3)
  assert.equal(total.totalAgentTimeMs, 60000)
})
