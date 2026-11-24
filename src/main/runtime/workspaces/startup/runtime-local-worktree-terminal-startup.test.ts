import { expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  startRuntimeLocalWorktreeTerminals,
  type RuntimeLocalWorktreeTerminalPorts
} from './runtime-local-worktree-terminal-startup'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup reads only the new workspace's id and path.
const worktree = { id: 'wt-1', path: '/repo/wt-1' } as Worktree

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup reads back only the handle it is given.
const terminal = { handle: 'term-1' } as RuntimeTerminalCreate

function terminalPorts(
  createTerminal: RuntimeLocalWorktreeTerminalPorts['createTerminal']
): RuntimeLocalWorktreeTerminalPorts {
  return {
    canSpawn: true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn(async () => ({ setupSpawned: false, setupTerminalHandle: null })),
    activate: vi.fn()
  }
}

/** A plugin's create that owes its new workspace an agent, a draft and a prompt. */
function pluginCreate(
  ports: RuntimeLocalWorktreeTerminalPorts,
  beforeEffect: () => void
): Promise<unknown> {
  return startRuntimeLocalWorktreeTerminals({
    request: { beforeEffect },
    repo: { id: 'repo-1' },
    worktree,
    startup: { command: 'claude' },
    draftPaste: { agent: 'claude', content: 'Summarize the change.' },
    startupFollowup: { agent: 'claude', prompt: 'Run the tests.' },
    ports
  })
}

const revoked = (): never => {
  throw new Error('plugin_approval_revoked')
}

it('starts no agent once its caller is refused while the startup terminal is prepared', async () => {
  let approved = true
  const ports = terminalPorts(async (_selector, options) => {
    await Promise.resolve()
    approved = false
    // Asked by the runtime right before it dispatches the PTY.
    options.onPtySpawnDispatched?.()
    return terminal
  })

  await expect(
    pluginCreate(ports, () => {
      if (!approved) {
        revoked()
      }
    })
  ).rejects.toThrow('plugin_approval_revoked')
  expect(ports.pasteDraft).not.toHaveBeenCalled()
  expect(ports.sendFollowup).not.toHaveBeenCalled()
  expect(ports.provision).not.toHaveBeenCalled()
  expect(ports.activate).not.toHaveBeenCalled()
})

it('delivers no prompt once its caller is refused after the agent started', async () => {
  const ports = terminalPorts(async () => terminal)

  await expect(pluginCreate(ports, revoked)).rejects.toThrow('plugin_approval_revoked')
  expect(ports.pasteDraft).not.toHaveBeenCalled()
  expect(ports.sendFollowup).not.toHaveBeenCalled()
})

it('starts no agent once its request ends while the startup terminal is prepared', async () => {
  const request = new AbortController()
  const ports = terminalPorts(async () => {
    // The runtime refuses to spawn for a request that already ended.
    request.abort(new Error('request_aborted'))
    throw new Error('client_disconnected')
  })

  await expect(
    startRuntimeLocalWorktreeTerminals({
      request: { signal: request.signal },
      repo: { id: 'repo-1' },
      worktree,
      startup: { command: 'claude' },
      ports
    })
  ).rejects.toThrow('request_aborted')
  expect(ports.pasteDraft).not.toHaveBeenCalled()
  expect(ports.sendFollowup).not.toHaveBeenCalled()
})
