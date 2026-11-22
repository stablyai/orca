import type { IPty } from 'node-pty'
import { expect, it, vi } from 'vitest'
import * as descendantSweep from '../../pty/process-retirement/pty-descendant-termination'
import * as posixGroups from '../../pty/process-retirement/posix-pty-process-groups'
import { LocalPtyProvider } from './local-pty-provider'
import {
  clearPtyState,
  exitedLocalPtyIncarnations,
  ptyAgentSessionIds,
  ptyIncarnations,
  ptyPhysicalExits,
  ptyProcesses,
  recordLocalPtyExit
} from './local-pty-provider-state'
import { createPtyPhysicalExit, shutdownLocalPty } from './local-pty-termination'

const original = {
  id: 'local-terminated-restart-fixture',
  expectedIncarnationId: 'known-incarnation',
  requireNoAgentOwner: false,
  requireUnattached: false
}

it('proves local retirement only for an incarnation that actually exited here', async () => {
  const provider = new LocalPtyProvider()
  await expect(provider.killFenced(original)).resolves.toEqual({
    outcome: 'refused',
    reason: 'unverifiable'
  })
  recordLocalPtyExit(original.id, original.expectedIncarnationId)
  try {
    await expect(provider.killFenced(original)).resolves.toEqual({ outcome: 'already_exited' })
    await expect(
      provider.killFenced({ ...original, expectedIncarnationId: 'different-incarnation' })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
  } finally {
    exitedLocalPtyIncarnations.delete(original.id)
  }
})

it('only advertises local termination for requests whose conditions the provider can prove', () => {
  const provider = new LocalPtyProvider()
  expect(provider.supportsFencedTermination(original.id)).toBe(false)
  expect(provider.supportsFencedTermination(original.id, original)).toBe(true)
  expect(
    provider.supportsFencedTermination(original.id, { ...original, requireUnattached: true })
  ).toBe(false)
  expect(
    provider.supportsFencedTermination(original.id, { ...original, requireNoAgentOwner: true })
  ).toBe(false)
})

it.skipIf(process.platform === 'win32')(
  'preserves the grace of an already pending local shutdown',
  async () => {
    const provider = new LocalPtyProvider()
    const id = original.id
    const signals: (string | undefined)[] = []
    const proc: IPty = {
      pid: 1,
      cols: 80,
      rows: 24,
      process: 'fixture',
      handleFlowControl: false,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      resize() {},
      clear() {},
      write() {},
      pause() {},
      resume() {},
      kill: (signal) => {
        signals.push(signal)
        ptyPhysicalExits.get(id)?.markExited()
      }
    }
    const captured = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const joined = Promise.withResolvers<void>()
    const sweep = vi
      .spyOn(descendantSweep, 'killWithDescendantSweep')
      .mockImplementation(async (_pid, stop) => {
        captured.resolve()
        await release.promise
        stop()
      })
    const force = vi
      .spyOn(posixGroups, 'forceKillPosixPtyProcessGroupsSync')
      .mockImplementation((_pid, stop) => stop())
    ptyProcesses.set(id, proc)
    ptyIncarnations.set(id, original.expectedIncarnationId)
    ptyAgentSessionIds.add(id)
    createPtyPhysicalExit(id)
    let current = true
    const ordinary = shutdownLocalPty(id, {})
    try {
      await captured.promise
      const restart = provider.killFenced(original, () => {
        if (!current) {
          throw new Error('terminal_pane_owner_changed')
        }
        joined.resolve()
      })
      await Promise.race([
        joined.promise,
        restart.then(() => {
          throw new Error('restart did not join')
        })
      ])
      current = false
      release.resolve()
      await expect(restart).resolves.toEqual({ outcome: 'ended' })
      expect(signals).toEqual(['SIGTERM'])
    } finally {
      release.resolve()
      await ordinary
      clearPtyState(id)
      sweep.mockRestore()
      force.mockRestore()
    }
  }
)
