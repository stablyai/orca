import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'

const mocks = vi.hoisted(() => ({ orcadLive: vi.fn(async () => false), exec: vi.fn() }))
vi.mock('../managed-server/install/orcad-remote-gc', () => ({
  isOrcadInstallDirLive: mocks.orcadLive
}))
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({
  execCommand: mocks.exec,
  isUnconfirmedSshCommandTermination: () => false
}))

import {
  isWslOrcadSlotInUse,
  wslOrcadSlotProcessProbeCommand
} from './wsl-orcad-slot-process-probe'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const host = getRemoteHostPlatform('linux-x64')

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}

describe.skipIf(process.platform === 'win32')('the slot process probe on a real shell', () => {
  let base: string
  let slotDir: string
  let userDataDir: string
  const stops: (() => void)[] = []

  /** A process whose argv names the slot, as a daemon launched from `<slot>/daemon-entry.js` does. */
  function runFromSlot(dir: string): number {
    const child = spawnProcess({
      program: '/bin/sh',
      args: ['-c', 'sleep 30; :', join(dir, 'daemon-entry.js')]
    })
    stops.push(() => child.kill('SIGKILL'))
    return child.pid ?? 0
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orca-slot-probe-'))
    slotDir = join(base, '.orca-remote', 'orcad-1.6.0+bb01')
    userDataDir = join(base, '.orca')
    mkdirSync(join(userDataDir, 'daemon'), { recursive: true })
    mkdirSync(slotDir, { recursive: true })
  })

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop()
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('reports nothing running and never counts itself', async () => {
    expect(await sh(wslOrcadSlotProcessProbeCommand(host, slotDir, userDataDir))).toBe('DEAD')
  })

  it('sees a process still running from the slot, such as a terminal daemon', async () => {
    runFromSlot(slotDir)
    await expect
      .poll(() => sh(wslOrcadSlotProcessProbeCommand(host, slotDir, userDataDir)))
      .toBe('LIVE')
  })

  it('does not mistake a sibling slot whose name extends this one', async () => {
    const siblings = [`${slotDir}.gc-tombstone.1`, join(base, '.orca-remote', 'orcad-1.5.0+aa01')]
    for (const sibling of siblings) {
      mkdirSync(sibling, { recursive: true })
      runFromSlot(sibling)
    }
    // Each sibling must be visibly running, or a DEAD answer here would prove nothing.
    for (const sibling of siblings) {
      await expect
        .poll(() => sh(wslOrcadSlotProcessProbeCommand(host, sibling, userDataDir)))
        .toBe('LIVE')
    }
    expect(await sh(wslOrcadSlotProcessProbeCommand(host, slotDir, userDataDir))).toBe('DEAD')
  })

  it('sees a daemon that names the resolved slot when the slot path runs through a symlink', async () => {
    const realHome = join(base, 'real-home')
    const realSlot = join(realHome, '.orca-remote', 'orcad-1.6.0+bb01')
    mkdirSync(realSlot, { recursive: true })
    symlinkSync(realHome, join(base, 'linked-home'))
    const linkedSlot = join(base, 'linked-home', '.orca-remote', 'orcad-1.6.0+bb01')
    runFromSlot(realpathSync(realSlot))
    await expect
      .poll(() => sh(wslOrcadSlotProcessProbeCommand(host, linkedSlot, userDataDir)))
      .toBe('LIVE')
  })

  it('keeps the copy when the slot cannot be resolved', async () => {
    const missing = join(base, '.orca-remote', 'orcad-0.0.0+gone')
    expect(await sh(wslOrcadSlotProcessProbeCommand(host, missing, userDataDir))).toBe('UNKNOWN')
  })

  it("sees the slot's daemon through its live pid file", async () => {
    const pid = runFromSlot(slotDir)
    writeFileSync(join(userDataDir, 'daemon', 'daemon-v3.pid'), JSON.stringify({ pid }))
    await expect
      .poll(() => sh(wslOrcadSlotProcessProbeCommand(host, slotDir, userDataDir)))
      .toBe('LIVE')
  })
})

describe('isWslOrcadSlotInUse', () => {
  const slot = {
    conn: Object.create(null),
    host,
    remoteHome: '/home/u',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 6768
  }
  const dir = '/home/u/.orca-remote/orcad-1.6.0+bb01'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.orcadLive.mockResolvedValue(false)
  })

  it('is free only when the server and the process scan both prove nothing runs there', async () => {
    mocks.exec.mockResolvedValue('DEAD\n')
    expect(await isWslOrcadSlotInUse(slot, dir)).toBe(false)
  })

  it.each(['LIVE\n', 'UNKNOWN\n', ''])('stays in use when the scan answers %j', async (answer) => {
    mocks.exec.mockResolvedValue(answer)
    expect(await isWslOrcadSlotInUse(slot, dir)).toBe(true)
  })

  it('stays in use when the scan fails or the server still runs', async () => {
    mocks.exec.mockRejectedValue(new Error('wsl.exe exited'))
    expect(await isWslOrcadSlotInUse(slot, dir)).toBe(true)
    mocks.orcadLive.mockResolvedValue(true)
    expect(await isWslOrcadSlotInUse(slot, dir)).toBe(true)
  })
})
