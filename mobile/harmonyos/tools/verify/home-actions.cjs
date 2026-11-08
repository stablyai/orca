const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')
const { createRpcPeer } = require('./fixtures/rpc-peer.cjs')
const { readHomeStats, totalHomeStats } = loadArkts('home/HomeStats.ets', [
  'readHomeStats',
  'totalHomeStats'
])
const { RpcSuccess } = createRpcPeer()
const { readHomeQuotaOffer, consumeHomeQuotaReset } = loadArkts(
  'home/HomeQuotaReset.ets',
  ['readHomeQuotaOffer', 'consumeHomeQuotaReset'],
  {
    RpcSuccess,
    util: { generateRandomUUID: () => '231bc5ac-3555-4010-8046-77121c5e3981' }
  }
)
function snapshot() {
  return {
    codex: {
      accounts: [
        {
          id: 'account',
          email: 'test@example.com',
          updatedAt: 10,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu'
        }
      ],
      activeAccountIdsByRuntime: { host: 'other', wsl: { Ubuntu: 'account' } }
    },
    rateLimits: {
      codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      codex: {
        provider: 'codex',
        updatedAt: 42,
        session: { usedPercent: 100, windowMinutes: 300, resetsAt: 90 },
        weekly: null,
        rateLimitResetCredits: {
          availableCount: 1,
          totalEarnedCount: 3,
          nextExpiresAt: null,
          credits: [{ status: 'available', expiresAt: 100, grantedAt: null }]
        }
      }
    }
  }
}
const scope = {
  target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
  accountId: 'account',
  accountRevision: 10,
  offerRevision: 'v1:[1,3,null,[["available",100,null]],[100,300,90],null,42]'
}

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

test('quota confirmation pins the selected WSL account and the complete quota revision', () => {
  const offer = readHomeQuotaOffer(JSON.stringify(snapshot()))
  assert.deepEqual(JSON.parse(JSON.stringify(offer.scope)), scope)
  const wrong = snapshot()
  wrong.codex.accounts[0].wslDistro = 'Debian'
  assert.equal(readHomeQuotaOffer(JSON.stringify(wrong)), null)
})

test('a reset sends its pinned scope once and accepts only the matching account receipt', async () => {
  let sent
  const result = await consumeHomeQuotaReset(
    {
      async request(method, params) {
        sent = { method, params: JSON.parse(params) }
        return new RpcSuccess(
          'reset',
          JSON.stringify({ outcome: 'reset', scope, snapshot: snapshot() })
        )
      }
    },
    scope
  )
  assert.equal(sent.method, 'accounts.consumeCodexResetCredit')
  assert.equal(sent.params.idempotencyKey, '231bc5ac-3555-4010-8046-77121c5e3981')
  assert.deepEqual(sent.params.expectedScope, scope)
  assert.equal(result.outcome, 'reset')
  const wrong = snapshot()
  wrong.rateLimits.codexTarget.wslDistro = 'Debian'
  await assert.rejects(
    consumeHomeQuotaReset(
      {
        async request() {
          return new RpcSuccess(
            'reset',
            JSON.stringify({ outcome: 'reset', scope, snapshot: wrong })
          )
        }
      },
      scope
    ),
    /Invalid reset result/
  )
})
