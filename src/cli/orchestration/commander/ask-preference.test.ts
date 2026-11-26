import { afterEach, expect, it, vi } from 'vitest'
import { orchestrationTestContext } from '../orchestration-handler-test-context'
import { askCommanderPreference } from './ask-preference'

const flags = new Map([
  ['commander-project', 'github:team/app'],
  ['question', 'Which Node version?'],
  ['request', 'worker-question-1']
])
function configure() {
  vi.stubEnv('ORCA_COMMANDER_MEMORY_GRANT_FILE', '')
  vi.stubEnv('ORCA_COMMANDER_MEMORY_URL', 'http://127.0.0.1/v1/commander/memory')
  vi.stubEnv('ORCA_COMMANDER_MEMORY_TOKEN', 'orcacmd_test')
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it.each([
  {
    matched: true,
    answer: 'Node 24',
    rulePageId: 'rule',
    ruleVersion: 2,
    decisionPageId: 'decision'
  },
  { matched: false, reason: 'missing' },
  { matched: false, reason: 'conflict' },
  { matched: false, reason: 'disabled' }
])('returns the audited project result to the coordinator', async (outcome) => {
  configure()
  const request = vi.fn(async () => Response.json(outcome))
  vi.stubGlobal('fetch', request)
  const print = vi.spyOn(console, 'log').mockImplementation(() => {})
  const ctx = orchestrationTestContext(vi.fn(), flags, true)
  await askCommanderPreference(ctx)
  expect(request).toHaveBeenCalledWith(
    'http://127.0.0.1/v1/commander/memory/preferences/ask',
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ authorization: 'Bearer orcacmd_test' }),
      body: JSON.stringify({
        expectedProjectId: 'github:team/app',
        expectedActorType: 'commander',
        requestId: 'worker-question-1',
        question: 'Which Node version?'
      })
    })
  )
  expect(print).toHaveBeenCalledWith(JSON.stringify({ ok: true, result: outcome }))
})

it('surfaces a scope rejection without supplying an answer', async () => {
  configure()
  const request = vi.fn(async () => new Response(null, { status: 403 }))
  vi.stubGlobal('fetch', request)
  await expect(
    askCommanderPreference(orchestrationTestContext(vi.fn(), flags, true))
  ).rejects.toThrow('403')
  expect(request).toHaveBeenCalledOnce()
})
it('rejects empty questions before sending any request', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(
    askCommanderPreference(
      orchestrationTestContext(vi.fn(), new Map(flags).set('question', ' \n '), true)
    )
  ).rejects.toThrow('1–500')
  expect(request).not.toHaveBeenCalled()
})

function configureHome() {
  for (const key of [
    'ORCA_COMMANDER_MEMORY_GRANT_FILE',
    'ORCA_COMMANDER_MEMORY_URL',
    'ORCA_COMMANDER_MEMORY_TOKEN',
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND'
  ]) {
    vi.stubEnv(key, undefined)
  }
  vi.stubEnv('ORCA_COMMANDER_HOME_CAPABILITY', 'x'.repeat(43))
}

it('uses the launch capability only on the local desktop and preserves exact multiline questions', async () => {
  configureHome()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const rpc = vi.fn(async () => ({ result: { matched: false, reason: 'missing' } }))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await askCommanderPreference(
    orchestrationTestContext(rpc, new Map(flags).set('question', 'First line\nsecond line'), true)
  )
  expect(rpc).toHaveBeenCalledExactlyOnceWith('commanderChat.askPreference', {
    capability: 'x'.repeat(43),
    projectId: 'github:team/app',
    requestId: 'worker-question-1',
    question: 'First line\nsecond line'
  })
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['paired', 'ssh', 'wsl', 'missing capability', 'invalid grant'])(
  'does not forward the home credential for %s',
  async (route) => {
    configureHome()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const rpc = vi.fn()
    const ctx = orchestrationTestContext(rpc, flags, true)
    if (route === 'paired') {
      vi.spyOn(ctx.client, 'isRemote', 'get').mockReturnValue(true)
    } else if (route === 'invalid grant') {
      vi.stubEnv('ORCA_COMMANDER_MEMORY_TOKEN', 'wrong')
    } else if (route === 'missing capability') {
      vi.stubEnv('ORCA_COMMANDER_HOME_CAPABILITY', undefined)
    } else {
      vi.stubEnv('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND', route)
    }
    await expect(askCommanderPreference(ctx)).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }
)
