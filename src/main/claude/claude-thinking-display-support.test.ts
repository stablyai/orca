import { describe, expect, it, vi } from 'vitest'
import { createClaudeThinkingDisplaySupport } from './claude-thinking-display-support'

const LAUNCH = { command: '/bin/claude', cwd: '/repo', env: { PATH: '/shims' } }
const UNKNOWN_FLAG = new Error(
  "claude stream-json exited (code 1): error: unknown option '--thinking-display'"
)

type Probe = (
  command: string,
  launch: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<string | null>

function supportWith(
  probe: Probe,
  budgetMs = 20,
  keyOf = async (command: string, cwd: string): Promise<string | null> => `${command}\n${cwd}`
) {
  const calls = vi.fn(probe)
  // Real time plus whatever a test skips ahead.
  let skippedMs = 0
  const support = createClaudeThinkingDisplaySupport({
    probe: calls,
    keyOf,
    budgetMs,
    now: () => performance.now() + skippedMs
  })
  return { support, calls, skip: (ms: number) => (skippedMs += ms) }
}

/** A probe the test answers by hand. */
function heldProbe() {
  let answer: (version: string | null) => void = () => {}
  const probe: Probe = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  return { probe, answer: (version: string | null) => answer(version) }
}

describe('the thinking-display flag a launch passes', () => {
  it("probes with the launch's own cwd and env and its own kill timeout, then remembers", async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledWith('/bin/claude', {
      cwd: '/repo',
      env: { PATH: '/shims' },
      timeoutMs: 10_000
    })
  })

  it('asks again per workspace: a shim can pick a different CLI there', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    await support.argsFor({ ...LAUNCH, cwd: '/other' })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('passes nothing to a CLI older than the flag, and keeps that answer for good', async () => {
    const { support, calls, skip } = supportWith(async () => '2.1.92')
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    skip(60 * 60_000)
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('asks again after a while when a probe printed no version, failed or was killed', async () => {
    for (const probe of [async () => null, () => Promise.reject(new Error('EMFILE'))]) {
      const { support, calls, skip } = supportWith(probe)
      await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
      // Within the window a hung or broken probe costs no further spawn or wait.
      skip(9 * 60_000)
      await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
      expect(calls).toHaveBeenCalledTimes(1)
      // A failure from a loaded boot heals.
      skip(2 * 60_000)
      await support.argsFor(LAUNCH)
      expect(calls).toHaveBeenCalledTimes(2)
    }
  })

  it('waits for a probe that answers within the budget', async () => {
    const { support } = supportWith(
      () => new Promise((resolve) => setTimeout(() => resolve('2.1.280'), 5)),
      1_000
    )
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })

  it('does not wait again on a probe already past its budget, and keeps its late answer', async () => {
    const held = heldProbe()
    const { support, calls } = supportWith(held.probe, 30)
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    const started = performance.now()
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    expect(performance.now() - started).toBeLessThan(25)
    held.answer('2.1.280')
    await vi.waitFor(async () =>
      expect(await support.argsFor(LAUNCH)).toEqual({ 'thinking-display': 'summarized' })
    )
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('stops passing the flag to a binary that exited refusing it', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await vi.waitFor(async () => expect(await support.argsFor(LAUNCH)).toEqual({}))
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('keeps a refusal seen while a probe was still running', async () => {
    const held = heldProbe()
    const { support } = supportWith(held.probe, 10)
    await support.argsFor(LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await new Promise((resolve) => setTimeout(resolve, 0))
    held.answer('2.1.280')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
  })

  it('records nothing for any other startup failure', async () => {
    const { support } = supportWith(async () => '2.1.280')
    await support.argsFor(LAUNCH)
    support.observeExit(LAUNCH, new Error('claude stream-json exited (code 1): not signed in'))
    support.observeExit(LAUNCH, new Error("error: unknown option '--thinking'"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })

  it('spends the budget finding the binary too, and caches nothing when that runs out', async () => {
    let slow = true
    const { support, calls } = supportWith(
      async () => '2.1.280',
      30,
      async (command, cwd) => {
        if (slow) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        return `${command}\n${cwd}`
      }
    )
    const started = performance.now()
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({})
    expect(performance.now() - started).toBeLessThan(500)
    expect(calls).not.toHaveBeenCalled()
    slow = false
    await expect(support.argsFor(LAUNCH)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })

  it('forgets the binaries launched least recently, not the ones in use', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    const at = (index: number) => ({ ...LAUNCH, cwd: `/repo-${index}` })
    for (let index = 1; index <= 32; index += 1) {
      await support.argsFor(at(index))
    }
    await support.argsFor(at(1))
    await support.argsFor(at(33))
    expect(calls).toHaveBeenCalledTimes(33)
    await support.argsFor(at(1))
    expect(calls).toHaveBeenCalledTimes(33)
    await support.argsFor(at(2))
    expect(calls).toHaveBeenCalledTimes(34)
  })
})
