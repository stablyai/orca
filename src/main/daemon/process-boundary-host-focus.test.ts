import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessBoundaryGround,
  PROCESS_BOUNDARY_GROUND
} from '../../shared/terminal-mode-reset-profiles'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import { PtyShellOwnershipMirror } from '../runtime/pty-shell-ownership-mirror'
import { HeadlessEmulator } from './headless-emulator'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

// Recovery must not re-enable input modes that downstream scanners would attribute to a new program.

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

async function recover(data: string, expectedGround = PROCESS_BOUNDARY_GROUND) {
  const live = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 100 })
  emulators.push(live)
  const mirror = new PtyShellOwnershipMirror(async () => true)
  const released: PtyIngressEmission[] = []
  const barrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: async () => true,
    release: (emission) => {
      released.push(emission)
      live.writeSync(emission.data)
      mirror.scan(emission.data)
    },
    isAlive: () => true
  })
  barrier.accept({ data, rawStartSeq: 0, rawEndSeq: data.length, transformed: false })
  await vi.waitFor(() => expect(released).toHaveLength(4))
  const markerStart = data.indexOf(COMMAND_DONE)
  const markerEnd = markerStart + COMMAND_DONE.length
  expect(released).toEqual([
    {
      data: data.slice(0, markerStart),
      rawStartSeq: 0,
      rawEndSeq: markerStart,
      transformed: false
    },
    { data: COMMAND_DONE, rawStartSeq: markerStart, rawEndSeq: markerEnd, transformed: false },
    { data: expectedGround, rawStartSeq: markerEnd, rawEndSeq: markerEnd, transformed: true },
    {
      data: data.slice(markerEnd),
      rawStartSeq: markerEnd,
      rawEndSeq: data.length,
      transformed: false
    }
  ])
  expect(released.map((emission) => emission.data).join('')).toBe(
    `${data.slice(0, markerEnd)}${expectedGround}${data.slice(markerEnd)}`
  )
  await mirror.settle()
  const ground = released[2]!.data
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
      `\x1b[?1004h${PROMPT}${COMMAND_START}\x1b[?1003hRUN\r\n${COMMAND_DONE}$ `,
      buildProcessBoundaryGround({ keepFocusReporting: true })
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
