import { describe, expect, it, vi } from 'vitest'
import {
  buildProcessBoundaryGround,
  PROCESS_BOUNDARY_GROUND
} from '../../shared/terminal-mode-reset-profiles'
import { Session } from './session'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'
import type { SubprocessHandle } from './session-subprocess-handle'

// Why this suite: a normal-buffer program that arms input modes and dies used
// to be cleaned only in the renderer, so the daemon kept the stale modes.

const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;1\x07'
const PROMPT_START = '\x1b]133;A\x07'
const HOST_FOCUS_GROUND = buildProcessBoundaryGround({ keepFocusReporting: true })

function triggers(scanner: TerminalShellLifecycleScanner, chunk: string): boolean {
  return scanner.scan(chunk).uncleanDeathTriggerEnd !== undefined
}

describe('armed input modes arm the unclean-death trigger', () => {
  it.each([
    ['mouse protocol and SGR encoding', '\x1b[?1003h\x1b[?1006h'],
    ['focus reporting', '\x1b[?1004h'],
    ['a kitty keyboard push', '\x1b[>1u'],
    ['application keypad', '\x1b[?66h']
  ])('triggers when a normal-buffer program dies with %s armed', (_label, arm) => {
    const scanner = new TerminalShellLifecycleScanner()
    const chunk = `${COMMAND_START}${arm}PROGRAM${COMMAND_DONE}$ `

    const events = scanner.scan(chunk)

    expect(events.uncleanDeathTriggerEnd).toBe(chunk.length - '$ '.length)
  })

  it('never triggers for modes a shell prompt arms itself', () => {
    const scanner = new TerminalShellLifecycleScanner()

    expect(triggers(scanner, `\x1b[?2004h\x1b[?1h\x1b=$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(
      false
    )
    expect(triggers(scanner, `\x1b[?2004h\x1b[?1h$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
  })

  it('does not trigger when the program disarms its modes before exiting', () => {
    const scanner = new TerminalShellLifecycleScanner()
    const chunk = `${COMMAND_START}\x1b[?1003h\x1b[?1006h\x1b[>1uRUN\x1b[?1003l\x1b[?1006l\x1b[<u${COMMAND_DONE}`

    expect(triggers(scanner, chunk)).toBe(false)
  })

  it('stays one-shot until a fresh enable', () => {
    const scanner = new TerminalShellLifecycleScanner()

    expect(triggers(scanner, `${COMMAND_START}\x1b[?1004hRUN${COMMAND_DONE}`)).toBe(true)
    // A refuted proof leaves ?1004 armed; later prompts must not pause again.
    expect(triggers(scanner, `$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
    expect(triggers(scanner, `$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
    expect(triggers(scanner, `$ ${COMMAND_START}\x1b[?1000hRUN${COMMAND_DONE}`)).toBe(true)
  })

  it('treats modes the prompt armed before the command started as shell-owned', () => {
    // fish's sequence (src/tty_handoff.rs; no recorded transcript): under tmux it arms
    // focus, sets kitty flags with `=5u` at the prompt and clears them with `=0u` before a command.
    const scanner = new TerminalShellLifecycleScanner()
    const prompt = '\x1b[?1004h\x1b[=5u$ \x1b[=0u'

    expect(triggers(scanner, `${prompt}${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
    expect(triggers(scanner, `${prompt}${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
    expect(triggers(scanner, `${prompt}${COMMAND_START}\x1b[?1002hRUN${COMMAND_DONE}`)).toBe(true)
  })

  it('tracks kitty flags per screen like xterm, so a clean alt exit leaves none armed', () => {
    const scanner = new TerminalShellLifecycleScanner()

    expect(
      triggers(scanner, `$ ${COMMAND_START}\x1b[?1049h\x1b[>1uTUI\x1b[?1049l${COMMAND_DONE}`)
    ).toBe(false)
    // The shell prompt's own main-screen flags survive a TUI's alt round trip.
    expect(
      triggers(
        scanner,
        `\x1b[>5u$ ${COMMAND_START}\x1b[?1049h\x1b[>1uTUI\x1b[?1049l${COMMAND_DONE}`
      )
    ).toBe(false)
  })

  it('still triggers when a TUI dies on the alt screen with its kitty flags pushed', () => {
    const scanner = new TerminalShellLifecycleScanner()

    expect(triggers(scanner, `$ ${COMMAND_START}\x1b[?1049h\x1b[>1uTUI${COMMAND_DONE}`)).toBe(true)
  })

  it('bounds the kitty stack so the ground can always clear it', () => {
    const scanner = new TerminalShellLifecycleScanner()
    // Uncapped, 250 pushes outlast the ground's two pop-99s, so a later pop would restore flags 5.
    scanner.scan(`${COMMAND_START}${'\x1b[>5u'.repeat(250)}RUN`)
    scanner.scan(PROCESS_BOUNDARY_GROUND)

    expect(triggers(scanner, `\x1b[?1000h\x1b[?1000l\x1b[<uRUN${COMMAND_DONE}`)).toBe(false)
  })

  it('drops main-screen kitty flags that a bare ?1049l swaps out', () => {
    const scanner = new TerminalShellLifecycleScanner()

    // xterm swaps in the (empty) alt-screen flags even with no matching ?1049h.
    expect(triggers(scanner, `${COMMAND_START}\x1b[>1u\x1b[?1049lRUN${COMMAND_DONE}`)).toBe(false)
  })

  it('stays inert for the ground: it clears the armed set without re-arming', () => {
    const scanner = new TerminalShellLifecycleScanner()
    scanner.seedOwner('shell')
    expect(triggers(scanner, `${COMMAND_START}\x1b[?1003h\x1b[>1uRUN${COMMAND_DONE}`)).toBe(true)
    const generation = scanner.generation

    expect(triggers(scanner, PROCESS_BOUNDARY_GROUND)).toBe(false)
    expect(scanner.generation).toBe(generation)
    expect(triggers(scanner, `$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
  })

  it('keeps host focus through the ground and clears the rest, without a new owner', () => {
    const scanner = new TerminalShellLifecycleScanner()
    scanner.seedOwner('shell')
    const prompt = `\x1b[?1004h\x1b[>5u$ ${COMMAND_START}`
    expect(triggers(scanner, `${prompt}\x1b[?1003h\x1b[>1uRUN${COMMAND_DONE}`)).toBe(true)
    const generation = scanner.generation

    // Kitty flags are never the host's: the ground clears them and the next prompt sets its own.
    expect(scanner.groundProcessBoundary()).toBe(HOST_FOCUS_GROUND)
    expect(scanner.generation).toBe(generation)
    expect(triggers(scanner, `$ ${COMMAND_START}ls${COMMAND_DONE}`)).toBe(false)
  })
})

function createSubprocess(confirmed: boolean) {
  let onData: ((data: string) => void) | null = null
  const confirmShellForeground = vi.fn(async () => confirmed)
  const handle: SubprocessHandle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground,
    write: () => {},
    resize: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    terminateOwnedTree: () => 'unavailable',
    onData(cb) {
      onData = cb
    },
    onExit() {},
    dispose: () => {}
  }
  return {
    handle,
    confirmShellForeground,
    emit: (data: string) => onData?.(data)
  }
}

async function runNormalBufferDeath(confirmed: boolean) {
  const sub = createSubprocess(confirmed)
  const session = new Session({
    sessionId: `armed-${confirmed}`,
    cols: 80,
    rows: 24,
    subprocess: sub.handle,
    shellReadySupported: false
  })
  sub.emit(`$ run\r\n${COMMAND_START}\x1b[?1003h\x1b[?1006h\x1b[?1004hPROGRAM\r\n${COMMAND_DONE}$ `)
  await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
  await session.settleShellOwnershipConfirmation()
  const snapshot = session.getSnapshot()
  const records = session.takePendingOutput(false)?.records ?? []
  session.dispose()
  return { snapshot, records }
}

// Each step's proof verdict applies to any recovery episode that step opens.
async function runSteps(steps: readonly { data: string; confirm?: boolean }[]) {
  let confirmed = false
  const sub = createSubprocess(true)
  sub.confirmShellForeground.mockImplementation(async () => confirmed)
  const session = new Session({
    sessionId: 'steps',
    cols: 80,
    rows: 24,
    subprocess: sub.handle,
    shellReadySupported: false
  })
  for (const step of steps) {
    confirmed = step.confirm ?? false
    sub.emit(step.data)
    await session.settleShellOwnershipConfirmation()
  }
  const snapshot = session.getSnapshot()
  const records = session.takePendingOutput(false)?.records ?? []
  const proofs = sub.confirmShellForeground.mock.calls.length
  session.dispose()
  return { snapshot, records, proofs }
}

describe('host-armed modes survive and command-armed modes do not', () => {
  it('never triggers on host modes when 133;D arrives without a 133;C', async () => {
    // PowerShell without PSReadLine emits A and D but never C.
    const { snapshot, proofs } = await runSteps([
      { data: `\x1b[?1004h${PROMPT_START}PS> ` },
      { data: `dir\r\n${COMMAND_DONE}${PROMPT_START}PS> `, confirm: true }
    ])

    expect(proofs).toBe(0)
    expect(snapshot?.snapshotAnsi).toContain('\x1b[?1004h')
  })

  it('keeps an enable after a mid-command full reset owned by the command', async () => {
    const { snapshot } = await runSteps([
      { data: `${PROMPT_START}$ ${COMMAND_START}` },
      { data: '\x1bc' },
      { data: `\x1b[?1000hRUN\r\n${COMMAND_DONE}` },
      {
        data: `${PROMPT_START}$ ${COMMAND_START}\x1b[?1003hRUN\r\n${COMMAND_DONE}${PROMPT_START}$ `,
        confirm: true
      }
    ])

    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
  })

  it('keeps host focus through a mid-command RIS that ConPTY answers by re-sending it', async () => {
    const { snapshot, records } = await runSteps([
      { data: `\x1b[?1004h${PROMPT_START}PS> ${COMMAND_START}` },
      {
        data: `\x1bc\x1b[?1004h\x1b[?9001h\x1b[?1000hRUN\r\n\x1b]133;D;0\x07${PROMPT_START}PS> `,
        confirm: true
      }
    ])

    expect(
      records.some((record) => record.kind === 'output' && record.data.includes(HOST_FOCUS_GROUND))
    ).toBe(true)
    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
    expect(snapshot?.snapshotAnsi).toContain('\x1b[?1004h')
  })

  it('keeps a host mode host-owned when a program re-sends its enable', async () => {
    const { snapshot } = await runSteps([
      { data: `\x1b[?1004h${PROMPT_START}$ ${COMMAND_START}` },
      { data: `\x1b[?1004hRUN\r\n${COMMAND_DONE}` },
      {
        data: `${PROMPT_START}$ ${COMMAND_START}\x1b[?1000hRUN\r\n${COMMAND_DONE}${PROMPT_START}$ `,
        confirm: true
      }
    ])

    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
    expect(snapshot?.snapshotAnsi).toContain('\x1b[?1004h')
  })
})

describe("prompt-armed focus is the host's only once a 133;C proves the prompt ended", () => {
  it.each([
    ['keeps it after a C', `${COMMAND_START}\x1b[?1003hRUN`, HOST_FOCUS_GROUND],
    ['grounds it without a C', '\x1b[?1049hTUI', PROCESS_BOUNDARY_GROUND]
  ])('%s', (_label, command, ground) => {
    const scanner = new TerminalShellLifecycleScanner()
    const events = scanner.scan(`${PROMPT_START}\x1b[?1004h$ ${command}${COMMAND_DONE}`)

    expect(events.uncleanDeathTriggerEnd).toBeDefined()
    expect(scanner.groundProcessBoundary()).toBe(ground)
  })
})

describe('Session grounds a proven normal-buffer death', () => {
  it('records the ground and leaves the daemon emulator with mouse and focus off', async () => {
    const { snapshot, records } = await runNormalBufferDeath(true)

    expect(
      records.some(
        (record) => record.kind === 'output' && record.data.includes(PROCESS_BOUNDARY_GROUND)
      )
    ).toBe(true)
    expect(snapshot?.modes.mouseTracking).toBe(false)
    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
    expect(snapshot?.snapshotAnsi).not.toContain('\x1b[?1004h')
    expect(snapshot?.terminalOwner).toBe('shell')
  })

  it('keeps focus reporting the host armed before the first prompt (ConPTY)', async () => {
    const sub = createSubprocess(true)
    const session = new Session({
      sessionId: 'conpty-focus',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    })
    sub.emit(
      `\x1b[?1004h${PROMPT_START}PS> ${COMMAND_START}\x1b[?1003hPROGRAM\r\n${COMMAND_DONE}PS> `
    )
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
    await session.settleShellOwnershipConfirmation()
    const snapshot = session.getSnapshot()
    const records = session.takePendingOutput(false)?.records ?? []
    session.dispose()

    expect(
      records.some((record) => record.kind === 'output' && record.data.includes(HOST_FOCUS_GROUND))
    ).toBe(true)
    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
    expect(snapshot?.snapshotAnsi).toContain('\x1b[?1004h')
    expect(snapshot?.terminalOwner).toBe('shell')
  })

  it('turns off a mode a program leaked past a refuted proof at the next ground', async () => {
    let confirmed = false
    const sub = createSubprocess(true)
    sub.confirmShellForeground.mockImplementation(async () => confirmed)
    const session = new Session({
      sessionId: 'leaked-baseline',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    })
    sub.emit(`\x1b[?1004h${PROMPT_START}PS> ${COMMAND_START}\x1b[?1003hTUI\r\n${COMMAND_DONE}`)
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(1))
    await session.settleShellOwnershipConfirmation()
    confirmed = true
    // Why a fresh arm: the one-shot trigger re-arms only on a new enable.
    sub.emit(`${PROMPT_START}PS> ${COMMAND_START}\x1b[?1000hRUN\r\n${COMMAND_DONE}PS> `)
    await vi.waitFor(() => expect(sub.confirmShellForeground).toHaveBeenCalledTimes(2))
    await session.settleShellOwnershipConfirmation()
    const snapshot = session.getSnapshot()
    const records = session.takePendingOutput(false)?.records ?? []
    session.dispose()

    expect(
      records.some((record) => record.kind === 'output' && record.data.includes(HOST_FOCUS_GROUND))
    ).toBe(true)
    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
    expect(snapshot?.snapshotAnsi).toContain('\x1b[?1004h')
  })

  it('flushes without the ground when the proof is refuted', async () => {
    const { snapshot, records } = await runNormalBufferDeath(false)

    expect(
      records.some(
        (record) => record.kind === 'output' && record.data.includes(PROCESS_BOUNDARY_GROUND)
      )
    ).toBe(false)
    expect(snapshot?.modes.mouseTracking).toBe(true)
    expect(snapshot?.snapshotAnsi).toContain('$ ')
  })

  it('never holds a plain prompt for a proof', async () => {
    const sub = createSubprocess(true)
    const session = new Session({
      sessionId: 'plain-prompt',
      cols: 80,
      rows: 24,
      subprocess: sub.handle,
      shellReadySupported: false
    })
    sub.emit(`\x1b[?2004h\x1b[?1h$ ${COMMAND_START}ls\r\nfile${COMMAND_DONE}\x1b[?2004h$ `)
    await session.settleShellOwnershipConfirmation()

    expect(sub.confirmShellForeground).not.toHaveBeenCalled()
    expect(session.getSnapshot()?.modes.bracketedPaste).toBe(true)
    session.dispose()
  })
})
