import { describe, expect, it } from 'vitest'
import {
  isLiveUsageLimitMenu,
  planUsageLimitResetSelection
} from '../../shared/usage-limit-menu-selection'
import {
  buildRestoredTerminalTailSeed,
  computeTerminalTailWaitState,
  tailGainedNewerUsageLimitStall
} from './orca-runtime'
import { detectUsageLimitStall } from './usage-limit-stall-detection'

function stateFor(text: string) {
  return computeTerminalTailWaitState([text], '', text)
}

describe('usage-limit tail-state edge trigger', () => {
  it('exposes a usage-limit signal on the memoized wait state', () => {
    const state = stateFor("You've hit your session limit · resets 3:50pm")
    expect(state.usageLimitSignal?.reason).toBe('usage-limit-banner')
  })

  it('fires once when a fresh stall appears in the appended chunk', () => {
    const before = stateFor('working on it…')
    const appended = "\nYou've hit your session limit · resets 3:50pm"
    const after = computeTerminalTailWaitState(
      ['working on it…', "You've hit your session limit · resets 3:50pm"],
      '',
      ''
    )
    expect(tailGainedNewerUsageLimitStall(before, after, appended)).toBe(true)
  })

  it('does not re-fire on stale banner text already in the previous tail', () => {
    const banner = "You've hit your session limit · resets 3:50pm"
    const before = stateFor(banner)
    // A later spinner redraw chunk with no new limit line must not re-arm.
    const after = computeTerminalTailWaitState([banner, '⠋ thinking'], '', '')
    expect(tailGainedNewerUsageLimitStall(before, after, '\n⠋ thinking')).toBe(false)
  })

  it('fires again when a banner lands under the chooser the watcher just cleared', () => {
    // The menu path's second act. Pressing Enter on "Stop and wait for limit to
    // reset" does not resume anything — Claude then prints a limit banner and
    // idles, and THAT is the event the auto-resume timer has to arm on. The
    // dismissed chooser never leaves the retained tail, so this only fires if
    // the appended banner outranks the older menu text by position.
    const menu = '❯ 1. Stop and wait for limit to reset'
    const banner = "You've hit your monthly spend limit"
    const before = stateFor(menu)
    const after = computeTerminalTailWaitState([menu, banner], '', '')
    expect(after.usageLimitSignal?.reason).toBe('usage-limit-banner')
    expect(tailGainedNewerUsageLimitStall(before, after, `\n${banner}`)).toBe(true)
  })

  // The tail-shape prefilter decides whether detection runs at all, so every
  // phrase usage-limit-stall-detection.ts can match must survive it. A missed
  // phrase here means the watcher silently never arms for that wording.
  it.each([
    ["You've hit your session limit · resets 3:50pm", 'usage-limit-banner'],
    ['You have reached your weekly limit.', 'usage-limit-banner'],
    // The detector's participle forms: `hitting` sits inside `hit`+`ting`, which
    // an alternation written as `(?:hit|reach)(?:ing|ed)?` silently loses.
    ['You are hitting your weekly limit.', 'usage-limit-banner'],
    ['Reaching your session limit.', 'usage-limit-banner'],
    ['Approaching limit — usage limit reached for this 5-hour window', 'usage-limit-banner'],
    ['❯ 1. Stop and wait for limit to reset', 'usage-limit-menu'],
    ['2. Ask your admin for more usage', 'usage-limit-menu'],
    // Claude Code 2.1.234+ handles the limit itself; these three lines are that
    // feature's whole lifecycle and every one of them has to reach detection.
    [
      'Usage limit reached · continuing automatically at 3:45pm · esc to cancel',
      'usage-limit-cli-waiting'
    ],
    ['Your usage limit has reset · press enter to continue', 'usage-limit-reset-prompt'],
    [
      'Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again',
      'usage-limit-banner'
    ]
  ])('survives the tail-shape prefilter: %s', (line, reason) => {
    expect(stateFor(line).usageLimitSignal?.reason).toBe(reason)
  })

  // The counterpart guarantee: the prefilter must stay narrow. A bare `limit`
  // sentinel would pin every later wait-check on this PTY to the full 256 KiB
  // tail rebuild for as long as the line stays in the retained tail.
  it.each([
    'const delimiter = ","',
    'SELECT * FROM jobs LIMIT 10',
    'ulimit -n 4096',
    'unlimited retries enabled'
  ])('does not treat ordinary output as a usage-limit candidate: %s', (line) => {
    const state = computeTerminalTailWaitState([line], '', '')
    expect(state.usageLimitSignal).toBeNull()
    // Nothing matched either sentinel, so the tail must not have been rebuilt.
    expect(state.waitText).toBe('')
  })
})

// The exact bytes Claude Code painted into a pane that then sat parked for three
// hours with the watcher armed (2026-08-28). Ink writes the chooser, then parks
// the cursor five rows up on the highlighted option (ESC[5A). Cursor-up stands
// in for the erase-to-end-of-screen the tail normalizer filters out, so it drops
// every row below the cursor: options 2..n and the confirm hint are gone from
// the retained tail, and the chooser reaches the parser as a single option.
const PARKED_CHOOSER_FRAME =
  '\x1b[38;2;177;185;249m───────────────\x1b[39m\r\r\n' +
  '\x1b[3G\x1b[38;2;177;185;249m\x1b[1mWhat\x1b[8Gdo\x1b[11Gyou\x1b[15Gwant\x1b[20Gto\x1b[23Gdo?\x1b[22m\x1b[39m\r\r\n\r\r\n' +
  '\x1b[3G\x1b[38;2;177;185;249m❯\x1b[5G\x1b[38;2;153;153;153m1.\x1b[8G\x1b[38;2;177;185;249mStop\x1b[13Gand\x1b[17Gwait\x1b[22Gfor\x1b[26Glimit\x1b[32Gto\x1b[35Greset\x1b[39m\r\r\n' +
  '\x1b[5G\x1b[38;2;153;153;153m2.\x1b[8G\x1b[39mUpgrade\x1b[16Gyour\x1b[21Gplan\r\r\n\r\r\n' +
  '\x1b[3G\x1b[38;2;153;153;153m\x1b[3mEnter\x1b[9Gto\x1b[12Gconfirm\x1b[20G·\x1b[22GEsc\x1b[26Gto\x1b[29Gcancel\x1b[23m\x1b[39m\r\r\n' +
  '\x1b[38;2;8;145;178m─────────── portal fixes ──\x1b[39m\r\r\n' +
  '\x1b[2C\x1b[5A\x1b[?2026l'

describe('a real parked usage-limit chooser', () => {
  const seed = buildRestoredTerminalTailSeed(PARKED_CHOOSER_FRAME)
  const waitText = [...(seed?.lines ?? []), seed?.partialLine ?? ''].join('\n')

  it('mirrors the screen only down to the parked cursor', () => {
    // Documents the truncation rather than endorsing it: the rows below the
    // cursor are still on the user's screen, but the tail cannot see them.
    expect(waitText).toContain('❯ 1. Stop and wait for limit to reset')
    expect(waitText).not.toContain('Upgrade your plan')
    expect(waitText).not.toContain('Enter to confirm')
  })

  it('is still detected, read as live, and actionable with no arrow presses', () => {
    expect(detectUsageLimitStall(waitText.toLowerCase())?.reason).toBe('usage-limit-menu')
    expect(isLiveUsageLimitMenu(waitText)).toBe(true)
    expect(planUsageLimitResetSelection(waitText)).toBe(0)
  })
})

// The restore-seed shape. A renderer snapshot is SerializeAddon output: the
// screen's rows, then a RELATIVE cursor restore (ESC[nA up to the cursor row)
// ahead of Orca's absolute CUP. The seed builder applies that cursor-up like
// live bytes, so where the CLI parked its cursor decides what the parser sees.
function snapshotSeedWaitText(rows: string[], cursorRowsFromBottom: number): string {
  // No cursor-up when the cursor is already on the last row: SerializeAddon
  // emits none there, and ESC[0A would read as ESC[1A anyway.
  const up = cursorRowsFromBottom > 0 ? `\x1b[${cursorRowsFromBottom}A` : ''
  const snapshot = `${rows.join('\r\n')}${up}\x1b[${rows.length - cursorRowsFromBottom};3H`
  const seed = buildRestoredTerminalTailSeed(snapshot)
  return [...(seed?.lines ?? []), seed?.partialLine ?? ''].join('\n')
}

describe('a usage-limit chooser restored from a renderer snapshot', () => {
  // The rows the CLI paints above the options, copied from the captured frame
  // above. They matter to the parser, not just to the eye: one numbered row on
  // its own is indistinguishable from output that quotes the menu, so the
  // single-row reading only counts inside this frame.
  const frame = ['─────────────────────────────', '  What do you want to do?', '']
  const chrome = [
    'Enter to confirm · Esc to cancel',
    '⏵⏵ auto mode on (shift+tab to cycle)',
    '5h (14%) 18:50 | 7d (31%) Wed 12:00'
  ]
  const menu = ['❯ 1. Stop and wait for limit to reset', '  2. Upgrade your plan']
  const rows = [...frame, ...menu, '', ...chrome]

  it('reads as live when the cursor was parked on the highlighted row', () => {
    const waitText = snapshotSeedWaitText(rows, rows.length - frame.length - 1)
    expect(waitText).not.toContain('Enter to confirm')
    expect(waitText).not.toContain('Upgrade your plan')
    expect(isLiveUsageLimitMenu(waitText)).toBe(true)
  })

  it('reads as live when the cursor sat at the bottom under the chrome', () => {
    const waitText = snapshotSeedWaitText(rows, 0)
    expect(waitText).toContain('Enter to confirm')
    expect(isLiveUsageLimitMenu(waitText)).toBe(true)
  })

  it('reads as dead once the prompt box owns the cursor beneath a dismissed chooser', () => {
    const dismissedRows = [
      '❯ 1. Stop and wait for limit to reset',
      '  2. Upgrade your plan',
      'Enter to confirm · Esc to cancel',
      '⏺ Read(src/main/index.ts)',
      '╭──────────────╮',
      '│ >            │',
      '╰──────────────╯',
      '⏵⏵ auto mode on (shift+tab to cycle)'
    ]
    // Cursor parked in the prompt box: the rows beneath it are dropped, so the
    // four lines left under the chooser fit the old budget and read as live.
    const waitText = snapshotSeedWaitText(dismissedRows, 2)
    expect(waitText).not.toContain('auto mode')
    expect(waitText).toContain('│ >')
    expect(isLiveUsageLimitMenu(waitText)).toBe(false)
  })
})
