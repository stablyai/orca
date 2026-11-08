import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../../managed-server/install/orcad-host-transport'

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
vi.mock('../../ssh/remote-exec/remote-exec-command', () => ({
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
vi.mock('../../managed-server/install/orcad-remote-context', async () => {
  const { execCommand } = await import('../../ssh/remote-exec/remote-exec-command')
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
import { readWslHostFacts, WSL_HOST_FACTS_COMMAND } from './wsl-orcad-held-context'

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
