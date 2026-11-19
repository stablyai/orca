import { expect, it, vi } from 'vitest'
import { pairedBotRosterCache, readPairedBotRosters } from './paired-bot-rosters'

const ENTRY = {
  id: 'rel',
  name: 'Bot-Release-Manager',
  agent: 'codex',
  paused: false,
  specialty: 'Cuts releases',
  linked: [],
  chats: { count: 1, home: true }
}

function servers(answers: Record<string, unknown>) {
  return {
    listOrchestrationWorkerServers: async () => [
      { environmentId: 'env-air', name: 'm4 air' },
      { environmentId: 'env-box', name: 'Build Box' },
      { environmentId: 'env-box-2', name: 'Build Box' }
    ],
    callOrchestrationWorkerServer: vi.fn(
      async (environmentId: string, method: string, params: unknown) => {
        expect(method).toBe('bots.roster')
        // Each server's bot list only: no fan-out of its own, and no bot's chats read.
        expect(params).toEqual({ withoutChats: true })
        const answer = answers[environmentId]
        if (answer instanceof Error) {
          throw answer
        }
        return answer
      }
    )
  }
}

it("reads each paired server's bots with the --on that reaches it, and says which can't be read", async () => {
  const runtime = servers({
    'env-air': { bots: [ENTRY, { id: 'broken' }] },
    'env-box': { bots: [] },
    'env-box-2': new Error('not connected')
  })
  expect(await readPairedBotRosters(runtime)).toEqual([
    {
      environmentId: 'env-air',
      server: { name: 'm4 air', on: 'm4 air' },
      bots: [
        {
          id: 'rel',
          name: 'Bot-Release-Manager',
          agent: 'codex',
          paused: false,
          specialty: 'Cuts releases',
          linked: [],
          server: { name: 'm4 air', on: 'm4 air' }
        }
      ]
    },
    // Two servers share a name, so each is reached by its id.
    { environmentId: 'env-box', server: { name: 'Build Box', on: 'env-box' }, bots: [] },
    {
      environmentId: 'env-box-2',
      server: { name: 'Build Box', on: 'env-box-2' },
      unreachable: true
    }
  ])
})

it('reads only the servers asked for', async () => {
  const runtime = servers({ 'env-air': { bots: [ENTRY] } })
  const read = await readPairedBotRosters(runtime, new Set(['env-air']))
  expect(read.map((roster) => roster.environmentId)).toEqual(['env-air'])
  expect(runtime.callOrchestrationWorkerServer).toHaveBeenCalledTimes(1)
})

it('answers from the last read without waiting, reads again behind it, and keeps the last answer when a read fails', async () => {
  const answers: Record<string, unknown> = { 'env-air': { bots: [ENTRY] } }
  const runtime = servers(answers)
  const read = pairedBotRosterCache(runtime)
  const air = new Set(['env-air'])

  expect(await read(air)).toEqual([
    { environmentId: 'env-air', server: { name: 'm4 air', on: 'm4 air' }, bots: null }
  ])
  await vi.waitFor(async () => expect((await read(air))[0]?.bots?.[0]?.name).toBe(ENTRY.name))

  answers['env-air'] = new Error('not connected')
  const calls = runtime.callOrchestrationWorkerServer.mock.calls.length
  await vi.waitFor(async () => {
    await read(air)
    expect(runtime.callOrchestrationWorkerServer.mock.calls.length).toBeGreaterThan(calls + 1)
  })
  expect((await read(air))[0]?.bots?.[0]?.name).toBe(ENTRY.name)
})
