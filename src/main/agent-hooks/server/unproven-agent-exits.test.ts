import { expect, it } from 'vitest'
import { UnprovenAgentExits } from './unproven-agent-exits'

it('re-proves once for a mark that lands while the first proof still reads a live agent', async () => {
  const answers: ((settled: boolean) => void)[] = []
  const exits = new UnprovenAgentExits(
    () => new Promise<boolean>((resolve) => answers.push(resolve))
  )
  // A nested shell's mark starts a proof that sees the live agent...
  exits.launchRetired('pane', true, true)
  // ...which quits at its real mark before that proof answers.
  exits.onCommandFinished('pane')
  exits.onCommandFinished('pane')
  expect(answers).toHaveLength(1)
  answers[0](false)
  await new Promise((resolve) => setImmediate(resolve))
  expect(answers).toHaveLength(2)
  answers[1](true)
  await new Promise((resolve) => setImmediate(resolve))
  exits.onCommandFinished('pane')
  expect(answers).toHaveLength(2)
})
