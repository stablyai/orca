import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyShellOwnershipMirror } from '../runtime/pty-shell-ownership-mirror'
import { HeadlessEmulator } from './headless-emulator'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

// Why this suite: the recovery ground must turn off only what the dead program
// armed, and inject no enables, since every consumer scans the injected bytes for ownership.

const PROMPT = '\x1b]133;A\x07$ '
const COMMAND_START = '\x1b]133;C\x07'
const COMMAND_DONE = '\x1b]133;D;1\x07'
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const PRIVATE_MODE_ENABLE = /\x1b\[\?([0-9;]+)h/g

const emulators: HeadlessEmulator[] = []

afterEach(() => {
  for (const created of emulators.splice(0)) {
    created.dispose()
  }
})

/** Feeds `data` through a confirming barrier into a daemon emulator and a runtime mirror. */
async function recover(data: string) {
  const live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 100 })
  emulators.push(live)
  const mirror = new PtyShellOwnershipMirror(async () => true)
  const released: string[] = []
  const barrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: async () => true,
    release: (emission) => {
      released.push(emission.data)
      live.writeSync(emission.data)
      mirror.scan(emission.data)
    },
    isAlive: () => true
  })
  barrier.accept({ data, rawStartSeq: 0, rawEndSeq: data.length, transformed: false })
  await vi.waitFor(() => expect(released).toHaveLength(3))
  await mirror.settle()
  const ground = released[1]!
  const enabled = [...ground.matchAll(PRIVATE_MODE_ENABLE)].map((match) => match[1])
  return { ground, enabled, live: live.getSnapshot(), barrier, mirror }
}

describe('process boundary ground at a proven crash', () => {
  it('turns off mouse modes a program armed before the first prompt marker', async () => {
    // .zshrc starts tmux, which dies with mouse armed before the shell's first 133;A.
    const { enabled, live } = await recover(
      `\x1b[?1000h\x1b[?1006h${PROMPT}${COMMAND_START}\x1b[?1003hRUN\r\n${COMMAND_DONE}$ `
    )

    expect(enabled).toEqual(['25'])
    expect(live.modes.mouseTrackingMode).toBe('none')
  })

  it("keeps ConPTY's focus reporting without injecting an enable a mirror would read as a new owner", async () => {
    const { ground, enabled, live, barrier, mirror } = await recover(
      `\x1b[?1004h${PROMPT}${COMMAND_START}\x1b[?1003hRUN\r\n${COMMAND_DONE}$ `
    )

    expect(ground).not.toContain('\x1b[?1004l')
    expect(enabled).toEqual(['25'])
    expect(live.modes.mouseTrackingMode).toBe('none')
    expect(live.snapshotAnsi).toContain('\x1b[?1004h')
    expect(barrier.getOwner()).toBe('shell')
    expect(mirror.owner).toBe('shell')
  })

  it('still turns off focus reporting a command armed', async () => {
    const { ground, live, mirror } = await recover(
      `${PROMPT}${COMMAND_START}\x1b[?1004hRUN\r\n${COMMAND_DONE}$ `
    )

    expect(ground).toContain('\x1b[?1004l')
    expect(live.snapshotAnsi).not.toContain('\x1b[?1004h')
    expect(mirror.owner).toBe('shell')
  })
})
