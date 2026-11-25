import { describe, expect, it } from 'vitest'
import { getUtf8ByteLength } from '../../shared/text/utf8-byte-limits'
import { splitImText } from './im-stream-chunks'
import { ImLiveStream } from './im-stream-live'
import { imStep, maskImText } from './im-stream-step'
import { ImStreamThrottle, type ImStreamTimer } from './im-stream-throttle'
import { EMPTY_IM_TURN_VIEW } from './im-stream-turn-view'

/** A clock and timer the test moves by hand. */
function manualClock() {
  let now = 0
  const timers: { at: number; run: () => void }[] = []
  const timer: ImStreamTimer = (run, ms) => {
    const entry = { at: now + ms, run }
    timers.push(entry)
    return () => {
      const index = timers.indexOf(entry)
      if (index !== -1) {
        timers.splice(index, 1)
      }
    }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  // Lets pending work register its timers before each one is due.
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      await settle()
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) {
        break
      }
      timers.shift()
      now = Math.max(now, next.at)
      next.run()
    }
    now = until
    await settle()
  }
  return { now: () => now, timer, advance }
}

describe('ImStreamThrottle', () => {
  it('writes at most once per gap, never two at once, and only the newest waiting frame', async () => {
    const clock = manualClock()
    const starts: { frame: number; at: number }[] = []
    let inFlight = 0
    let maxInFlight = 0
    const throttle = new ImStreamThrottle<number>(
      async (frame) => {
        starts.push({ frame, at: clock.now() })
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => clock.timer(resolve, 1500))
        inFlight--
      },
      () => undefined,
      { gapMs: 1000, now: clock.now, timer: clock.timer }
    )
    for (let frame = 1; frame <= 40; frame++) {
      throttle.offer(frame)
      await clock.advance(100)
    }
    await clock.advance(10_000)
    const done = throttle.finish(99)
    await clock.advance(10_000)
    await done

    expect(maxInFlight).toBe(1)
    for (let index = 1; index < starts.length; index++) {
      expect(starts[index]!.at - starts[index - 1]!.at).toBeGreaterThanOrEqual(1000)
    }
    expect(starts[0]!.frame).toBe(1)
    expect(starts.at(-2)!.frame).toBe(40)
    expect(starts.at(-1)!.frame).toBe(99)
    expect(starts.length).toBeLessThan(10)
  })

  it('writes nothing more after close, and the final frame after the one in flight', async () => {
    const clock = manualClock()
    const order: string[] = []
    const throttle = new ImStreamThrottle<string>(
      async (frame) => {
        order.push(`start ${frame}`)
        await new Promise<void>((resolve) => clock.timer(resolve, 300))
        order.push(`end ${frame}`)
      },
      () => undefined,
      { gapMs: 1000, now: clock.now, timer: clock.timer }
    )
    throttle.offer('a')
    throttle.offer('b')
    const done = throttle.finish('final')
    throttle.offer('late')
    await clock.advance(5000)
    await done
    expect(order).toEqual(['start a', 'end a', 'start final', 'end final'])
  })
})

describe('ImLiveStream', () => {
  it('degrades once on a permission failure and stops writing', async () => {
    const clock = manualClock()
    const writes: string[] = []
    const degraded: string[] = []
    const live = new ImLiveStream({
      write: async (text) => {
        writes.push(text)
        throw new Error('no permission')
      },
      classify: () => 'permission',
      render: (view) => view.answer,
      deadline: 60_000,
      onDegraded: (reason) => degraded.push(reason),
      now: clock.now,
      timer: clock.timer,
      gapMs: 1000
    })
    live.update({ ...EMPTY_IM_TURN_VIEW, phase: 'running', answer: 'one' })
    await clock.advance(2000)
    live.update({ ...EMPTY_IM_TURN_VIEW, phase: 'running', answer: 'two' })
    await clock.advance(2000)
    expect(writes).toEqual(['one'])
    expect(degraded).toEqual(['permission'])
    expect(live.degraded).toBe('permission')
  })
})

describe('IM step text', () => {
  it('shows a tool name and a short line, never a key, token or raw env value', () => {
    const step = imStep(
      'Bash',
      { command: 'curl -H "Authorization: Bearer synthetic-bearer-value" https://x.test' },
      'running'
    )
    expect(step.name).toBe('Bash')
    expect(step.summary.length).toBeLessThanOrEqual(80)
    expect(step.summary).not.toContain('synthetic-bearer-value')
    const env = imStep('Bash', { command: 'OPENAI_API_KEY=synthetic-env-value node x.js' }, 'done')
    expect(env.summary).not.toContain('synthetic-env-value')
    for (const command of [
      'export PLAIN=synthetic-plain-value && MY_VAR="synthetic quoted" node x.js',
      'psql postgresql://admin:synthetic-userinfo@db.test:5432/x',
      `${'cd /tmp/a && '.repeat(5)}DB_URL=postgres://u:synthetic-userinfo@h/db?sslkey=synthetic-query pnpm test`
    ]) {
      const masked = JSON.stringify(imStep('Bash', { command }, 'done'))
      expect(masked).not.toMatch(/synthetic-(plain|quoted|userinfo|query)|synthetic quoted/)
    }
    const long = imStep('Read', { file_path: `/tmp/${'a'.repeat(300)}.ts` }, 'done')
    expect(long.summary.length).toBeLessThanOrEqual(80)
    expect(maskImText('refresh_token=synthetic-refresh harness')).not.toContain('synthetic-refresh')
  })
})

describe('splitImText', () => {
  it('keeps every character, in order, within the byte limit', () => {
    const text = Array.from(
      { length: 400 },
      (_, index) => `第${index}段：${'内容'.repeat(index % 37)} emoji 🎉 line ${index}`
    ).join('\n')
    const parts = splitImText(text, 2048)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(getUtf8ByteLength(part)).toBeLessThanOrEqual(2048)
    }
    const bodies = parts.map((part, index) =>
      part
        .replace(index > 0 ? /^\(\d+\/\d+\)\n/ : /^/, '')
        .replace(index < parts.length - 1 ? /\n\n\(\d+\/\d+, continued\)$/ : /$/, '')
    )
    expect(bodies.join('')).toBe(text)
  })

  it('closes a code block at a cut and reopens it in the next part', () => {
    const text = `intro\n\`\`\`ts\n${'const x = 1\n'.repeat(400)}\`\`\`\nafter`
    const parts = splitImText(text, 1024)
    expect(parts.length).toBeGreaterThan(2)
    for (const part of parts) {
      const fences = part.split('\n').filter((line) => line.startsWith('```')).length
      expect(fences % 2).toBe(0)
    }
  })
})
