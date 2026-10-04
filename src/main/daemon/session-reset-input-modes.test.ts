import { describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

function createSession() {
  let onData: ((data: string) => void) | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Session reads only these members.
  const handle = {
    pid: 999,
    getForegroundProcess: () => null,
    confirmShellForeground: vi.fn(async () => false),
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    forceKill: () => {},
    signal: () => {},
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit() {},
    dispose: () => {}
  } as unknown as SubprocessHandle
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the omitted options are optional.
  const session = new Session({
    sessionId: 'reset',
    cols: 80,
    rows: 24,
    subprocess: handle,
    shellReadySupported: false
  } as never)
  const received: string[] = []
  session.attachClient({ onData: (data: string) => received.push(data), onExit: () => {} })
  return { session, received, emit: (data: string) => onData?.(data) }
}

async function readModes(session: Session) {
  await session.settleShellOwnershipConfirmation()
  return session.getSnapshot()!.modes
}

describe('Session.resetInputModes', () => {
  it('grounds modes an app left armed without a command end, and the next snapshot carries it', async () => {
    const { session, received, emit } = createSession()
    // A crashed app's arming with no OSC 133;D the barrier could ground at.
    emit('prompt$ app\r\n\x1b[>31u\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1h')
    const armed = await readModes(session)
    expect(armed).toMatchObject({
      kittyKeyboardFlags: 31,
      mouseTracking: true,
      bracketedPaste: true
    })
    session.takePendingOutput(false)
    const broadcast = received.length

    session.resetInputModes()

    expect(await readModes(session)).toMatchObject({
      kittyKeyboardFlags: 0,
      mouseTracking: false,
      sgrMouseMode: false,
      bracketedPaste: false,
      applicationCursor: false,
      alternateScreen: false
    })
    // Clients ground themselves; a zero-raw span here would be dropped or duplicated.
    expect(received).toHaveLength(broadcast)
    const records = session.takePendingOutput(false)!.records
    expect(records).toEqual([{ kind: 'output', data: expect.stringContaining('\x1b[<99u') }])
    session.dispose()
  })

  it('keeps focus reporting the terminal host armed for the pane', async () => {
    const { session, emit } = createSession()
    // ConPTY arms ?1004h before any shell marker.
    emit('\x1b[?1004hprompt$ ')
    await readModes(session)
    session.takePendingOutput(false)

    session.resetInputModes()

    const [record] = session.takePendingOutput(false)!.records
    expect(record).toMatchObject({ kind: 'output' })
    expect(record?.kind === 'output' && record.data).not.toContain('\x1b[?1004l')
    session.dispose()
  })
})
