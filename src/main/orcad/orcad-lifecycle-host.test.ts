import { randomUUID } from 'node:crypto'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { ProviderCleanupBudget } from '../provider-process/provider-process-exit-deadline'
import {
  installProviderLedgerEntry,
  providerLedgerDirectory,
  serializeProviderEntry
} from '../provider-process/provider-process-inventory'
import {
  startProviderRecoveryTask,
  verifyRecoveredProviderResources
} from '../provider-process/provider-process-ledger'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from './orcad-instance-lock'
import { startOrcadWithHost } from './orcad-lifecycle'
import { isDesktopBrowserBridgeHostEnabled } from '../runtime/desktop-browser-bridge/desktop-browser-bridge-registry'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startOrcadWithHost', () => {
  it('names the instance a managed stop must address, and releases its lock on a clean stop', async () => {
    const root = dataRoot()
    const saved = getAppEnvironment()
    setAppEnvironment({
      ...saved,
      getPath: (key) => (key === 'userData' ? root : saved.getPath(key))
    })
    const directory = providerLedgerDirectory(),
      gate = Promise.withResolvers<void>()
    mkdirSync(directory)
    const states = Array.from({ length: 5 }, (_, index) => {
      const entry = {
        version: 1 as const,
        origin: 'direct' as const,
        token: randomUUID(),
        directory,
        createdAt: Date.now(),
        pgid: 9_999_990 + index,
        owner: { pid: 9_999_999, pgid: 9_999_999, startedAt: 'gone' },
        members: [],
        groupRetired: true as const,
        resource: { kind: 'codex-home' as const, key: String(index) }
      }
      writeFileSync(join(directory, `${entry.token}.json`), JSON.stringify(entry))
      const state = installProviderLedgerEntry(entry)
      void serializeProviderEntry(state, () => gate.promise)
      return state
    })
    const budget = new ProviderCleanupBudget()
    const first = verifyRecoveredProviderResources('0', budget)
    const handle = await startOrcadWithHost(
      root,
      async (registerCleanup) => {
        const recovery = startProviderRecoveryTask()
        registerCleanup(() => recovery.cancelAndJoin())
        await recovery.ready
        return {}
      },
      () => {}
    )
    expect(readOrcadInstanceLockRecord(handle.instance.lockPath)).toMatchObject({
      pid: handle.instance.pid,
      nonce: handle.instance.nonce
    })
    try {
      const released = vi.fn(),
        stop = handle.stop().then(released)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(released).not.toHaveBeenCalled()
      expect(existsSync(handle.instance.lockPath)).toBe(true)
      expect(budget.signal.aborted).toBe(false)
      expect(states[4]?.flight).toBeUndefined()
      gate.resolve()
      await expect(first).resolves.toBe('released')
      await stop
      expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(false)
    } finally {
      gate.resolve()
      await first
      await handle.stop()
      setAppEnvironment(saved)
    }
  })

  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startOrcadWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })

  it('keeps the instance lock when a quit handler fails', async () => {
    const root = dataRoot()
    const handle = await startOrcadWithHost(
      root,
      async () => ({}),
      () => {
        throw new AggregateError([new Error('handler')], 'orcad_quit_handlers_failed')
      }
    )
    await expect(handle.stop()).rejects.toThrow('orcad_quit_handlers_failed')
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })

  // Only a client's managed launch (an SSH host) has a desktop that can opt in to serve its CLI.
  it.each([
    ['a managed launch', { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/me/.orca-server' }, true],
    ['a server the user started', {}, false]
  ])('takes desktop browser bridge commands only for %s', async (_name, env, expected) => {
    vi.stubEnv(ORCAD_MANAGED_ACTIVATION_ROOT_ENV, env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] ?? '')
    try {
      const handle = await startOrcadWithHost(
        dataRoot(),
        async () => ({}),
        () => {}
      )
      expect(isDesktopBrowserBridgeHostEnabled()).toBe(expected)
      await handle.stop()
      expect(isDesktopBrowserBridgeHostEnabled()).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
