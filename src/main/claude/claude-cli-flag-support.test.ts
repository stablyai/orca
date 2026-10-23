import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_PLUGIN_DIR_FLAG,
  CLAUDE_THINKING_DISPLAY_FLAG,
  createClaudeCliFlagSupport
} from './claude-cli-flag-support'

const LAUNCH = { command: '/bin/claude', cwd: '/repo', env: { PATH: '/shims' } }
const UNKNOWN_FLAG = new Error(
  "claude stream-json exited (code 1): error: unknown option '--thinking-display'"
)

type Support = ReturnType<typeof createClaudeCliFlagSupport>

const thinking = (support: Support, launch: typeof LAUNCH): Promise<boolean> =>
  support.supports(CLAUDE_THINKING_DISPLAY_FLAG, launch)

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
  const support = createClaudeCliFlagSupport({
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

describe('whether a launch passes a Claude CLI flag', () => {
  it("probes with the launch's own cwd and env and its own kill timeout, then remembers", async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledWith('/bin/claude', {
      cwd: '/repo',
      env: { PATH: '/shims' },
      timeoutMs: 10_000
    })
  })

  it('asks again per workspace: a shim can pick a different CLI there', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await thinking(support, LAUNCH)
    await thinking(support, { ...LAUNCH, cwd: '/other' })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('passes nothing to a CLI older than the flag, and keeps that answer for good', async () => {
    const { support, calls, skip } = supportWith(async () => '2.1.92')
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
    skip(60 * 60_000)
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('never remembers a probe that printed no version, failed or was killed: the next launch asks', async () => {
    for (const failure of [async () => null, () => Promise.reject(new Error('EMFILE'))]) {
      let answer: () => Promise<string | null> = failure
      const { support, calls } = supportWith(() => answer())
      await expect(thinking(support, LAUNCH)).resolves.toBe(false)
      // A loaded boot is exactly when probes fail; the next launch must not inherit that.
      answer = async () => '2.1.280'
      await expect(thinking(support, LAUNCH)).resolves.toBe(true)
      expect(calls).toHaveBeenCalledTimes(2)
    }
  })

  it('waits as long as the caller allows for a probe slower than the default budget', async () => {
    const { support, calls } = supportWith(
      () => new Promise((resolve) => setTimeout(() => resolve('2.1.280'), 60)),
      20
    )
    const [plugins, thinkingDisplay] = await Promise.all([
      support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH, 1_000),
      thinking(support, LAUNCH)
    ])
    // One probe answers both; only the caller that allowed for it waited.
    expect(plugins).toBe(true)
    expect(thinkingDisplay).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
  })

  it('bounds even a long budget: a probe that never answers costs at most that budget', async () => {
    const held = heldProbe()
    const { support } = supportWith(held.probe, 20)
    const started = performance.now()
    await expect(support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH, 80)).resolves.toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('waits for a probe that answers within the budget', async () => {
    const { support } = supportWith(
      () => new Promise((resolve) => setTimeout(() => resolve('2.1.280'), 5)),
      1_000
    )
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
  })

  it('does not wait again on a probe already past its budget, and keeps its late answer', async () => {
    const held = heldProbe()
    const { support, calls } = supportWith(held.probe, 30)
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
    const started = performance.now()
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
    expect(performance.now() - started).toBeLessThan(25)
    held.answer('2.1.280')
    await vi.waitFor(async () => expect(await thinking(support, LAUNCH)).toBe(true))
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('stops passing the flag to a binary that exited refusing it', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await thinking(support, LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await vi.waitFor(async () => expect(await thinking(support, LAUNCH)).toBe(false))
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('keeps a refusal seen while a probe was still running', async () => {
    const held = heldProbe()
    const { support } = supportWith(held.probe, 10)
    await thinking(support, LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await new Promise((resolve) => setTimeout(resolve, 0))
    held.answer('2.1.280')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
  })

  it("keeps the flag through another failure or another option's refusal", async () => {
    const { support } = supportWith(async () => '2.1.280')
    await thinking(support, LAUNCH)
    support.observeExit(LAUNCH, new Error('claude stream-json exited (code 1): not signed in'))
    support.observeExit(LAUNCH, new Error("error: unknown option '--thinking'"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
  })

  it('spends the budget finding the binary too, and caches nothing when that runs out', async () => {
    let slow = true
    let slowKeyTimer: ReturnType<typeof setTimeout> | undefined
    const { support, calls } = supportWith(
      async () => '2.1.280',
      30,
      async (command, cwd) => {
        if (slow) {
          await new Promise((resolve) => {
            slowKeyTimer = setTimeout(resolve, 1_000)
          })
        }
        return `${command}\n${cwd}`
      }
    )
    try {
      const started = performance.now()
      await expect(thinking(support, LAUNCH)).resolves.toBe(false)
      expect(performance.now() - started).toBeLessThan(500)
      expect(calls).not.toHaveBeenCalled()
      slow = false
      await expect(thinking(support, LAUNCH)).resolves.toBe(true)
    } finally {
      clearTimeout(slowKeyTimer)
    }
  })

  it('forgets the binaries launched least recently, not the ones in use', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    const at = (index: number) => ({ ...LAUNCH, cwd: `/repo-${index}` })
    for (let index = 1; index <= 32; index += 1) {
      await thinking(support, at(index))
    }
    await thinking(support, at(1))
    await thinking(support, at(33))
    expect(calls).toHaveBeenCalledTimes(33)
    await thinking(support, at(1))
    expect(calls).toHaveBeenCalledTimes(33)
    await thinking(support, at(2))
    expect(calls).toHaveBeenCalledTimes(34)
  })

  it('answers every flag from one probe, each against its own first version', async () => {
    const { support, calls } = supportWith(async () => '2.1.0')
    await expect(support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)).resolves.toBe(true)
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('shares a probe still running between flags', async () => {
    const held = heldProbe()
    const { support, calls } = supportWith(held.probe, 1_000)
    const both = Promise.all([
      thinking(support, LAUNCH),
      support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)
    ])
    await vi.waitFor(() => expect(calls).toHaveBeenCalled())
    held.answer('2.1.280')
    await expect(both).resolves.toEqual([true, true])
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('withdraws only the flag a binary refused', async () => {
    const { support } = supportWith(async () => '2.1.280')
    await thinking(support, LAUNCH)
    support.observeExit(LAUNCH, new Error("error: unknown option '--plugin-dir'"))
    await vi.waitFor(async () =>
      expect(await support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)).toBe(false)
    )
    await expect(thinking(support, LAUNCH)).resolves.toBe(true)
  })

  it('keeps a refusal through a failed probe and a later one that answers', async () => {
    let version: string | null = null
    const { support } = supportWith(async () => version)
    await thinking(support, LAUNCH)
    support.observeExit(LAUNCH, UNKNOWN_FLAG)
    await new Promise((resolve) => setTimeout(resolve, 0))
    version = '2.1.280'
    await expect(support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)).resolves.toBe(true)
    await expect(thinking(support, LAUNCH)).resolves.toBe(false)
  })

  it('prewarms without waiting, so a later launch finds the answer and spawns nothing', async () => {
    const held = heldProbe()
    const { support, calls } = supportWith(held.probe, 20)
    support.prewarm(LAUNCH)
    await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce())
    held.answer('2.1.280')
    await expect(support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)).resolves.toBe(true)
    support.prewarm(LAUNCH)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveBeenCalledOnce()
  })

  it('a prewarm that finds no binary probes nothing and throws nothing', async () => {
    const { support, calls } = supportWith(
      async () => '2.1.280',
      20,
      async () => {
        throw new Error('EACCES')
      }
    )
    support.prewarm(LAUNCH)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).not.toHaveBeenCalled()
  })

  it('answers from what is known without starting a probe when asked not to', async () => {
    const { support, calls } = supportWith(async () => '2.1.280')
    await expect(support.supports(CLAUDE_THINKING_DISPLAY_FLAG, LAUNCH, 250, false)).resolves.toBe(
      false
    )
    expect(calls).not.toHaveBeenCalled()
    await support.supports(CLAUDE_PLUGIN_DIR_FLAG, LAUNCH)
    await expect(support.supports(CLAUDE_THINKING_DISPLAY_FLAG, LAUNCH, 250, false)).resolves.toBe(
      true
    )
    expect(calls).toHaveBeenCalledOnce()
  })
})
