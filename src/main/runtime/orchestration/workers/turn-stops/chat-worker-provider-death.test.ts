import { expect, it } from 'vitest'
import type { StructuredAgentSessionEndedChild } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { batch, mutation, rig, SESSION, tick } from './chat-worker-request-failure-rig.test-fixture'

type Rig = Awaited<ReturnType<typeof rig>>

function ended(
  r: Rig,
  fence: number,
  overrides: Partial<StructuredAgentSessionEndedChild> = {}
): StructuredAgentSessionEndedChild {
  return {
    generation: `generation-${fence}`,
    fence,
    cause: 'exit',
    rootGone: true,
    reason: 'codex app-server exited (signal SIGKILL)',
    duringStartup: false,
    endedAt: r.journal.cursor(),
    ...overrides
  }
}

/** The child-exit order: death is seen, the dead generation is settled, then the edge repeats as settled. */
async function die(r: Rig, child: StructuredAgentSessionEndedChild, settle?: () => Promise<void>) {
  r.session.lastEndedChild = child
  await r.observer.generationEnded(SESSION)
  await settle?.()
  await r.observer.generationEnded(SESSION, { settled: true })
  await tick()
}

it('reports a provider that died between turns once per death, and again after mail restarted it', async () => {
  const r = await rig()
  await die(r, ended(r, 0))
  await die(r, r.session.lastEndedChild!)
  expect(r.mail().map((message) => message.subject)).toEqual(['Worker exited without reporting'])
  expect(r.mail()[0]?.body).toContain('exited (codex app-server exited (signal SIGKILL))')
  expect(r.mail()[0]?.body).toContain('A message restarts it')
  await die(r, ended(r, 1))
  expect(r.mail()).toHaveLength(2)
})

it('leaves a death that a request failure reports, an expected end and a failed start to their own reports', async () => {
  const r = await rig()
  await batch(r.journal, 'running', [
    mutation('dead', { kind: 'turn', turnId: 'dead', state: 'running' })
  ])
  await die(r, ended(r, 0), () =>
    batch(r.journal, 'cleanup', [
      mutation('dead', { kind: 'turn', turnId: 'dead', state: 'interrupted' })
    ])
  )
  expect(r.mail().map((message) => message.subject)).toEqual([
    expect.stringMatching(/^Agent hit an error/)
  ])
  for (const child of [
    ended(r, 1, { cause: 'evict' }),
    ended(r, 2, { cause: 'user-close' }),
    ended(r, 3, { duringStartup: true })
  ]) {
    await die(r, child)
  }
  expect(r.mail()).toHaveLength(1)
})
