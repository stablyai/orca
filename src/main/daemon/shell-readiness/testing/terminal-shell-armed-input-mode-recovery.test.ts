import { describe, expect, it, vi } from 'vitest'
import {
  buildProcessBoundaryGround,
  PROCESS_BOUNDARY_GROUND
} from '../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { Session } from '../../sessions/session'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'

const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;1\x07'
const PROMPT_START = '\x1b]133;A\x07'
const HOST_FOCUS_GROUND = buildProcessBoundaryGround({ keepFocusReporting: true })

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
    // Exercise another recovery episode after a refuted foreground proof.
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

  it("grounds an agent's modes when it dies after nested shells' refuted Ds", async () => {
    const leak = { data: `${COMMAND_START}nested\r\n${COMMAND_DONE}`, confirm: false }
    const { snapshot, records, proofs } = await runSteps([
      { data: `${PROMPT_START}$ ${COMMAND_START}\x1b[>1u\x1b[?1003hAGENT` },
      ...Array.from({ length: 5 }, () => leak),
      { data: `EXIT\r\n${COMMAND_DONE}${PROMPT_START}$ `, confirm: true },
      { data: `${COMMAND_START}ls\r\n${COMMAND_DONE}${PROMPT_START}$ ` }
    ])

    expect(proofs).toBe(6)
    expect(
      records.some(
        (record) => record.kind === 'output' && record.data.includes(PROCESS_BOUNDARY_GROUND)
      )
    ).toBe(true)
    expect(snapshot?.modes.mouseTrackingMode).toBe('none')
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
