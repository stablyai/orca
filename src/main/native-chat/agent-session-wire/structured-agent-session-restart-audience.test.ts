// A client too old to show an agent's chat is handed an audience without that agent. Every restart
// operation it calls leaves that agent's offers and failures alone, and never names them back.
// The chat here is a Codex one; an audience without Codex stands in for any agent the client
// cannot show.

import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

const cannotShowCodex = (agent: string) => agent !== 'codex'
const showsCodex = (agent: string) => agent === 'codex'

function offersIn(root: string) {
  return new AgentSessionRecoveryCapsule(root).list(NOW)
}

it('neither lists nor dismisses an offer the caller cannot show', async () => {
  const { host, root } = await interruptedRestart()

  expect(await host.restartResume.list(cannotShowCodex)).toEqual([])
  expect(await host.restartResume.dismiss(undefined, cannotShowCodex)).toBe(0)
  expect(await host.restartResume.dismiss([SESSION], cannotShowCodex)).toBe(0)
  expect(await offersIn(root)).toHaveLength(1)
  expect(await host.restartResume.list()).toHaveLength(1)

  // A caller that sees it dismisses it by dismissing everything it was shown.
  expect(await host.restartResume.dismiss(undefined, showsCodex)).toBe(1)
  expect(await offersIn(root)).toEqual([])
})

it('neither continues nor reserves an offer the caller cannot show, named or not', async () => {
  const { host, root, acquire, dispatch } = await interruptedRestart()

  for (const named of [undefined, [SESSION]]) {
    expect(await host.restartResume.continueAfterRestart(named, 'modal', cannotShowCodex)).toEqual({
      resumed: [],
      continued: [],
      ...(named ? { skipped: [SESSION] } : {}),
      sessions: [],
      failed: []
    })
  }
  expect(acquire).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  expect(await offersIn(root)).toHaveLength(1)

  const result = await host.restartResume.continueAfterRestart(undefined, 'modal', showsCodex)
  expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
})

it('keeps a failure the caller cannot show, and leaves it out of an action reply', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toHaveLength(1)

  expect(await host.restartResume.listFailures(cannotShowCodex)).toEqual([])
  // Naming a chat it can act on still answers with only what it can show.
  const reply = await host.restartResume.continueAfterRestart(
    ['another-session'],
    'modal',
    cannotShowCodex
  )
  expect(reply).toMatchObject({ sessions: [], failed: [] })
  expect(
    (await host.restartResume.continueAfterRestart(['another-session'], 'modal')).failed
  ).toHaveLength(1)

  expect(await host.restartResume.dismiss(undefined, cannotShowCodex)).toBe(0)
  expect(await host.restartResume.listFailures()).toHaveLength(1)
  expect(await host.restartResume.dismiss(undefined, showsCodex)).toBe(1)
  expect(await host.restartResume.listFailures()).toEqual([])
})
