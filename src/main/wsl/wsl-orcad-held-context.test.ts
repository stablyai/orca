import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const mocks = vi.hoisted(() => {
  const state: {
    spawned: string[]
    refused: string[]
    probeStep: (() => void) | null
    facts: string
    contextArgs: unknown[]
  } = {
    spawned: [],
    refused: [],
    probeStep: null,
    facts: '',
    contextArgs: []
  }
  return state
})

// Like the real execCommand: an aborted signal refuses before anything is spawned.
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({
  execCommand: vi.fn(
    async (_conn: unknown, command: string, options?: { signal?: AbortSignal }) => {
      const label =
        command === 'uname -r' ? command : command.includes('uname -r') ? 'host-facts' : command
      if (options?.signal?.aborted) {
        mocks.refused.push(label)
        throw options.signal.reason
      }
      mocks.spawned.push(label)
      if (label === 'uname -r') {
        return `${mocks.facts.includes('-Microsoft') ? '4.4.0-19041-Microsoft' : '5.15.167.4-microsoft-standard-WSL2'}\n`
      }
      return label === 'host-facts' ? mocks.facts : ''
    }
  )
}))
// Like the real context resolver given a known platform and home: its remaining probes in series.
vi.mock('../managed-server/install/orcad-remote-context', async () => {
  const { execCommand } = await import('../ssh/remote-exec/remote-exec-command')
  return {
    resolveOrcadRemoteContext: async (
      _target: unknown,
      conn: OrcadHostTransport,
      signal?: AbortSignal,
      ...known: unknown[]
    ) => {
      mocks.contextArgs = known
      for (const command of ['ldd --version', 'cat orcad-active.json']) {
        await new Promise<void>((resolve) => {
          mocks.probeStep = resolve
        })
        await execCommand(conn, command, { signal })
      }
      return { remoteHome: '/home/u' }
    }
  }
})

import { runProcess } from '@orca/process-host'
import {
  holdWslDistroWithContext,
  isWsl1KernelRelease,
  readWslHostFacts,
  WSL_HOST_FACTS_COMMAND
} from './wsl-orcad-held-context'

const target: WslOrcadHostTarget = { kind: 'wsl', id: 'wsl:u', distro: 'U', label: 'U' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
const conn = {} as OrcadHostTransport

function holderRejectingOn(gate: Promise<void>): WslDistroHolder {
  return {
    ensureHeld: vi.fn(async () => {
      await gate
      throw new Error('holder exited before the distro started')
    }),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    holderState: vi.fn()
  }
}

/** What WSL_HOST_FACTS_COMMAND prints. */
function facts(kernel: string, home: string, uname: string, libc = 'ldd (GNU libc) 2.39'): string {
  return `__ORCA_WSL_KERNEL__ ${kernel}\n__ORCA_WSL_HOME__ ${home}\n\n__ORCA_REMOTE_PLATFORM__ ${uname}\n\n__ORCA_WSL_LIBC__\n${libc}\n`
}

beforeEach(() => {
  mocks.spawned.length = 0
  mocks.refused.length = 0
  mocks.probeStep = null
  mocks.facts = facts('5.15.167.4-microsoft-standard-WSL2', '/home/u', 'Linux x86_64')
  mocks.contextArgs = []
})

describe('holdWslDistroWithContext', () => {
  it('probes the context while the hold is pending, and resolves only once the distro is held', async () => {
    let finishHold: () => void = () => {}
    const holdDone = new Promise<void>((resolve) => {
      finishHold = resolve
    })
    const hold: WslDistroHolder = {
      ...holderRejectingOn(holdDone),
      ensureHeld: vi.fn(async (distro: string) => {
        await holdDone
        return {
          outcome: 'spawned' as const,
          record: { version: 1 as const, distro, pid: 9, creationTimeMs: 1, startedAtMs: 1 }
        }
      })
    }
    let settled = false
    const held = holdWslDistroWithContext('U', target, conn, hold, undefined).finally(() => {
      settled = true
    })
    for (let step = 0; step < 2; step++) {
      await vi.waitFor(() => expect(mocks.probeStep).not.toBeNull())
      const next = mocks.probeStep
      mocks.probeStep = null
      next?.()
    }
    await vi.waitFor(() =>
      expect(mocks.spawned).toEqual(['host-facts', 'ldd --version', 'cat orcad-active.json'])
    )
    // The deploy awaits this before recovery, which may launch orcad.
    expect(settled).toBe(false)

    finishHold()

    await expect(held).resolves.toMatchObject({
      held: { outcome: 'spawned' },
      context: { remoteHome: '/home/u' }
    })
  })

  it('stops the context probes once the hold fails, so nothing can boot the distro again', async () => {
    let failHold: () => void = () => {}
    const holdFails = new Promise<void>((resolve) => {
      failHold = resolve
    })
    const held = holdWslDistroWithContext(
      'U',
      target,
      conn,
      holderRejectingOn(holdFails),
      undefined
    )
    await vi.waitFor(() => expect(mocks.probeStep).not.toBeNull())
    mocks.probeStep?.()
    await vi.waitFor(() => expect(mocks.spawned).toEqual(['host-facts', 'ldd --version']))

    failHold()
    await expect(held).rejects.toThrow('holder exited')
    mocks.probeStep?.()
    await vi.waitFor(() => expect(mocks.refused).toEqual(['cat orcad-active.json']))

    expect(mocks.spawned).toEqual(['host-facts', 'ldd --version'])
  })
})

describe('the folded host facts probe', () => {
  function heldNow(): WslDistroHolder {
    return {
      ...holderRejectingOn(Promise.resolve()),
      ensureHeld: vi.fn(async (distro: string) => ({
        outcome: 'adopted' as const,
        record: { version: 1 as const, distro, pid: 9, creationTimeMs: 1, startedAtMs: 1 }
      }))
    }
  }

  async function resolveWith(facts: string) {
    mocks.facts = facts
    const held = holdWslDistroWithContext('U', target, conn, heldNow(), undefined)
    for (let step = 0; step < 2; step++) {
      await vi.waitFor(() => expect(mocks.probeStep).not.toBeNull())
      const next = mocks.probeStep
      mocks.probeStep = null
      next?.()
    }
    return held
  }

  it('hands the context the platform and login home it read in the same exec', async () => {
    await resolveWith(mocks.facts)

    expect(mocks.spawned.filter((label) => label === 'host-facts')).toHaveLength(1)
    expect(mocks.contextArgs).toEqual([
      expect.objectContaining({ os: 'linux', arch: 'x64' }),
      {
        loginHome: '/home/u',
        firstLibcProbeOutput: 'ldd (GNU libc) 2.39\n',
        readActivationRecord: expect.any(Function)
      }
    ])
  })

  it('leaves the context to probe what the facts did not prove', async () => {
    await resolveWith(facts('5.15.167.4-microsoft-standard-WSL2', '', 'Linux sparc'))

    expect(mocks.contextArgs).toEqual([
      undefined,
      { loginHome: undefined, readActivationRecord: expect.any(Function) }
    ])
    expect(mocks.spawned[0]).toBe('host-facts')
    expect(mocks.spawned).not.toContain('uname -r')
  })

  it('falls back to the separate probes for a HOME with a newline, never a truncated path', async () => {
    await resolveWith(facts('5.15.167.4-microsoft-standard-WSL2', '/home/a\nb', 'Linux x86_64'))

    expect(mocks.contextArgs).toEqual([
      undefined,
      { loginHome: undefined, readActivationRecord: expect.any(Function) }
    ])
    expect(mocks.spawned.slice(0, 2)).toEqual(['host-facts', 'uname -r'])
  })

  it('falls back without throwing when stdout noise precedes the facts', async () => {
    await resolveWith(
      `Welcome to Ubuntu\n${facts('5.15.167.4-microsoft-standard-WSL2', '/home/u', 'Linux x86_64')}`
    )

    expect(mocks.contextArgs).toEqual([
      undefined,
      { loginHome: undefined, readActivationRecord: expect.any(Function) }
    ])
    expect(mocks.spawned.slice(0, 2)).toEqual(['host-facts', 'uname -r'])
  })

  it('keeps a multi-line libc answer whole, and rejects output missing the libc section', () => {
    const musl = 'musl libc (x86_64)\nVersion 1.2.4\nDynamic Program Loader'
    expect(
      readWslHostFacts(facts('5.15.167.4-microsoft-standard-WSL2', '/home/u', 'Linux x86_64', musl))
    ).toMatchObject({ firstLibcProbeOutput: `${musl}\n` })
    expect(
      readWslHostFacts(
        '__ORCA_WSL_KERNEL__ 5.15\n__ORCA_WSL_HOME__ /home/u\n\n__ORCA_REMOTE_PLATFORM__ Linux x86_64\n'
      )
    ).toBeNull()
  })

  it('refuses WSL 1 from the kernel line before holding or probing', async () => {
    mocks.facts = facts('4.4.0-19041-Microsoft', '/home/u', 'Linux x86_64')
    const holder = heldNow()

    await expect(
      holdWslDistroWithContext('U', target, conn, holder, undefined)
    ).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError'
    })
    expect(holder.ensureHeld).not.toHaveBeenCalled()
    expect(mocks.spawned).toEqual(['host-facts'])
  })
})

describe.skipIf(process.platform === 'win32')('WSL_HOST_FACTS_COMMAND under a real sh', () => {
  it('prints exactly the shape readWslHostFacts accepts', async () => {
    const result = await runProcess({
      program: 'sh',
      args: ['-c', WSL_HOST_FACTS_COMMAND],
      env: { ...process.env, HOME: '/home/orca user' },
      timeoutMs: 10_000
    })

    expect(readWslHostFacts(result.stdout)).toMatchObject({
      kernel: expect.stringMatching(/\S/),
      loginHome: '/home/orca user'
    })
  })
})

describe('isWsl1KernelRelease', () => {
  it('tells the WSL 1 syscall layer from a WSL 2 kernel, stock or custom', () => {
    expect(isWsl1KernelRelease('4.4.0-19041-Microsoft')).toBe(true)
    expect(isWsl1KernelRelease('4.4.0-22621-Microsoft\n')).toBe(true)
    expect(isWsl1KernelRelease('5.15.167.4-microsoft-standard-WSL2')).toBe(false)
    expect(isWsl1KernelRelease('6.6.36.6-microsoft-standard-WSL2+')).toBe(false)
    expect(isWsl1KernelRelease('6.10.0-custom')).toBe(false)
  })
})
