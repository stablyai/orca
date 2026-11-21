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

it('proves a tracked pane afresh for a sleep, whose last proof was voided', async () => {
  const answers: boolean[] = [false, true]
  let proofs = 0
  const exits = new UnprovenAgentExits(async () => answers[proofs++] ?? false)
  exits.launchRetired('pane', true, true)
  await new Promise((resolve) => setImmediate(resolve))
  expect(exits.has('pane')).toBe(true)
  // Sleep asks once more; the quit is proved now and the pane settles.
  await exits.settled('pane', true)
  await new Promise((resolve) => setImmediate(resolve))
  expect(exits.has('pane')).toBe(false)
})

it('has a sleep wait for the re-proof a quit queued behind a nested mark proof', async () => {
  const answers: ((settled: boolean) => void)[] = []
  const exits = new UnprovenAgentExits(
    () => new Promise<boolean>((resolve) => answers.push(resolve))
  )
  // A nested mark's proof runs; the real quit's mark queues another; then the sleep starts.
  exits.launchRetired('pane', true, true)
  exits.onCommandFinished('pane')
  let slept = false
  const sleep = exits.settled('pane', true).then(() => {
    slept = true
  })
  answers[0](false)
  await new Promise((resolve) => setImmediate(resolve))
  expect(slept).toBe(false)
  answers[1](true)
  await sleep
  expect(exits.has('pane')).toBe(false)
})
