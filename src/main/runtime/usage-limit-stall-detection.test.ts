import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectUsageLimitStall, extractUsageLimitResetAt } from './usage-limit-stall-detection'

// The runtime passes an ANSI-stripped, lowercased tail to detectUsageLimitStall.
const lc = (text: string): string => text.toLowerCase()

describe('detectUsageLimitStall', () => {
  it('detects the Claude Code idle session-limit banner', () => {
    const signal = detectUsageLimitStall(
      lc("You've hit your session limit · resets 3:50pm (Europe/London)")
    )
    expect(signal?.reason).toBe('usage-limit-banner')
  })

  it('detects a usage-limit banner phrased "hit your usage limit"', () => {
    expect(detectUsageLimitStall(lc("You've hit your usage limit. Try again later."))?.reason).toBe(
      'usage-limit-banner'
    )
  })

  it('detects the mislabeled monthly-spend-limit banner (real 5h limit)', () => {
    // Claude Code bug: with extra usage disabled, a 5-hour-limit hit renders as
    // a monthly spend limit. Real capture, 2026-08-27.
    const banner =
      "You've hit your monthly spend limit · raise it at " +
      'claude.ai/settings/usage?from=cc_cli_limit_message'
    expect(detectUsageLimitStall(lc(banner))?.reason).toBe('usage-limit-banner')
    // No reset time in the text: the service must take its unknown-reset path.
    expect(extractUsageLimitResetAt(lc(banner).split('\n'))).toBeNull()
  })

  it('detects a "usage limit reached" banner', () => {
    expect(detectUsageLimitStall(lc('Weekly limit reached — resets Thu'))?.reason).toBe(
      'usage-limit-banner'
    )
  })

  it('detects the Codex usage-limit error banner', () => {
    const codex =
      "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
      '(https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.'
    expect(detectUsageLimitStall(lc(codex))?.reason).toBe('usage-limit-banner')
  })

  // Claude Code 2.1.234 added an in-session wait that resumes the agent itself.
  // Its three screens are the whole reason the watcher has to know about it: on
  // the first one we must stand down, on the other two we are the only one left.
  describe("the CLI's own auto-continue", () => {
    it('stands down while the CLI is counting the limit down itself', () => {
      // The line carries "Usage limit reached", so the banner pattern matches it
      // too — and before this the watcher armed, waited out resetsAt and resent
      // `continue` into a session the CLI had already auto-continued.
      const line = 'Usage limit reached · continuing automatically at 3:45pm · esc to cancel'
      expect(detectUsageLimitStall(lc(line))?.reason).toBe('usage-limit-cli-waiting')
    })

    it('takes a fresh limit printed after a cancelled auto-continue', () => {
      // Esc cancels the wait; the next limit is a newer event and ours to handle.
      const tail = [
        'Usage limit reached · continuing automatically at 3:45pm · esc to cancel',
        '⏺ Edit(src/main/index.ts)',
        "You've hit your session limit · resets 6:10pm"
      ].join('\n')
      expect(detectUsageLimitStall(lc(tail))?.reason).toBe('usage-limit-banner')
    })

    it('reads the post-sleep keypress prompt as its own reason', () => {
      // The limit is already over here, so there is nothing to wait for and
      // nothing to type — which is why it cannot be folded into the banner path.
      const line = 'Your usage limit has reset · press enter to continue'
      expect(detectUsageLimitStall(lc(line))?.reason).toBe('usage-limit-reset-prompt')
    })

    it('takes over once the CLI stops re-arming after repeated hits', () => {
      const line =
        'Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again'
      expect(detectUsageLimitStall(lc(line))?.reason).toBe('usage-limit-banner')
      // No reset time in that text: the unknown-reset delay is the right path.
      expect(extractUsageLimitResetAt(lc(line).split('\n'))).toBeNull()
    })
  })

  it('detects the wait-for-reset menu', () => {
    const menu = [
      'What do you want to do?',
      '❯ 1. Stop and wait for limit to reset',
      '  2. Ask your admin for more usage',
      '  Enter to confirm · Esc to cancel'
    ].join('\n')
    expect(detectUsageLimitStall(lc(menu))?.reason).toBe('usage-limit-menu')
  })

  it('detects the menu even when the PTY collapses the spaces', () => {
    // The menu text sometimes renders with collapsed whitespace.
    expect(detectUsageLimitStall('stopandwaitforlimittoreset')?.reason).toBe('usage-limit-menu')
    expect(detectUsageLimitStall('askyouradminformoreusage')?.reason).toBe('usage-limit-menu')
  })

  it('classifies the menu over a banner when both are in the tail', () => {
    const tail = [
      "You've hit your session limit · resets 3pm",
      '❯ 1. Stop and wait for limit to reset'
    ].join('\n')
    expect(detectUsageLimitStall(lc(tail))?.reason).toBe('usage-limit-menu')
  })

  it('classifies a banner printed BELOW a dismissed chooser as the banner', () => {
    // Regression (the menu path's second act): after the watcher presses Enter,
    // the chooser's text stays in the retained tail forever. Ranking the menu
    // ahead of a banner regardless of position meant the banner Claude prints
    // next always scored behind the dead chooser, no newer stall was ever
    // recorded, and the session sat parked until a human noticed.
    const tail = [
      '❯ 1. Stop and wait for limit to reset',
      '  2. Ask your admin for more usage',
      "You've hit your monthly spend limit"
    ].join('\n')
    const signal = detectUsageLimitStall(lc(tail))
    expect(signal?.reason).toBe('usage-limit-banner')
    expect(signal?.index).toBeGreaterThan(lc(tail).indexOf('stop and wait'))
  })

  it('anchors the index to the latest banner when two coexist in the tail', () => {
    // Regression: two limit banners can sit in the retained tail (limit →
    // resume → limit again). The index must point at the NEWER one so the
    // runtime re-arms on the second event instead of the stale first.
    const tail = lc(
      "You've hit your session limit · resets 1pm\n" +
        'resumed and worked for a while\n' +
        "You've hit your session limit · resets 8pm"
    )
    const signal = detectUsageLimitStall(tail)
    expect(signal?.reason).toBe('usage-limit-banner')
    expect(signal?.index).toBe(tail.lastIndexOf('hit your'))
    expect(signal?.index).toBeGreaterThan(tail.indexOf('hit your'))
  })

  it('ignores the "Show plan usage limits" command palette entry', () => {
    expect(detectUsageLimitStall(lc('> Show plan usage limits'))).toBeNull()
  })

  it('ignores a /usage table that merely lists reset times', () => {
    const usage = [
      'Current session   45% used   resets 3:00pm',
      'Weekly            12% used   resets Thu'
    ].join('\n')
    expect(detectUsageLimitStall(lc(usage))).toBeNull()
  })

  it('ignores an ordinary idle prompt', () => {
    expect(detectUsageLimitStall(lc('> \n╭─ claude ─╮'))).toBeNull()
  })
})

describe('extractUsageLimitResetAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('parses the reset time from a banner into a future timestamp', () => {
    // Pin the clock so the "resets 3:50pm" wall-clock assertion is deterministic
    // regardless of when the suite runs.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T09:00:00'))
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your session limit · resets 3:50pm (Europe/London)"
    ])
    expect(typeof resetsAt).toBe('number')
    expect(resetsAt).toBeGreaterThan(Date.now())
  })

  it('parses a relative reset duration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T09:00:00'))
    const resetsAt = extractUsageLimitResetAt(['Usage limit reached. Resets in 3h 20m'])
    expect(resetsAt).toBeGreaterThan(Date.now())
  })

  it('returns null when the tail carries no reset (e.g. the menu)', () => {
    expect(extractUsageLimitResetAt(['❯ 1. Stop and wait for limit to reset'])).toBeNull()
  })

  it('parses Codex "or try again at <date>" including the ordinal suffix', () => {
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
        '(https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.'
    ])
    expect(resetsAt).toBe(new Date('Apr 23, 2026 10:42 AM').getTime())
  })

  it('parses a Codex reset with a PM time', () => {
    const resetsAt = extractUsageLimitResetAt(['or try again at May 14th, 2026 2:32 PM.'])
    expect(resetsAt).toBe(new Date('May 14, 2026 2:32 PM').getTime())
  })

  it('parses the NEWEST Codex reset when two banners coexist', () => {
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your usage limit … or try again at Apr 23rd, 2026 10:42 AM.",
      'worked, then hit the limit again',
      "You've hit your usage limit … or try again at May 14th, 2026 2:32 PM."
    ])
    expect(resetsAt).toBe(new Date('May 14, 2026 2:32 PM').getTime())
  })

  it('parses the NEWEST Claude reset when two banners coexist', () => {
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your session limit · resets Jan 5 at 4pm",
      'worked for a while',
      "You've hit your session limit · resets Jun 9 at 9am"
    ])
    expect(resetsAt).not.toBeNull()
    // June (month index 5) proves it anchored to the newer banner, not January.
    // `?? Number.NaN` keeps this cast-free: a null would make an Invalid Date,
    // whose getMonth() is NaN and fails the assertion just as loudly.
    expect(new Date(resetsAt ?? Number.NaN).getMonth()).toBe(5)
  })

  it('reads the reset past the CLI hint printed under the banner', () => {
    // Claude Code 2.1.280 prints this hint for accounts without usage credits.
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your session limit · resets Jan 5 at 4pm",
      '/upgrade to increase your usage limit.',
      'worked for a while',
      "  ⎿  You've hit your session limit · resets Jun 9 at 9am",
      '     /upgrade to increase your usage limit.'
    ])
    expect(new Date(resetsAt ?? Number.NaN).getMonth()).toBe(5)
  })
})
