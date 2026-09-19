import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createDaemonRecoveryProvider } from './daemon-recovery-provider'
import { getDaemonPidPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import type { DaemonPtyRouter } from './daemon-pty-router'

let harness: DaemonAdapterHarness
let provider: DaemonPtyRouter | undefined
beforeEach(async () => {
  harness = await startDaemonAdapterHarness(() => createMockSubprocess())
  copyFileSync(harness.tokenPath, getDaemonTokenPath(harness.dir))
})
afterEach(async () => {
  provider?.dispose()
  provider = undefined
  harness.adapter.dispose()
  await harness.server.shutdown()
  rmSync(harness.dir, { recursive: true, force: true })
})

it('recovers live terminals without pruning folder or unknown workspace sessions', async () => {
  await harness.adapter.spawn({ sessionId: 'folder-terminal', cols: 80, rows: 24 })
  provider = createDaemonRecoveryProvider(harness.dir, join(harness.dir, 'history'))
  expect(provider.getAllAdapters().every((entry) => entry.recoveryOnly)).toBe(true)
  await expect(provider.reconcileOnStartup(new Set())).resolves.toEqual({
    alive: ['folder-terminal'],
    killed: []
  })
  await expect(
    provider.spawn({ sessionId: 'folder-terminal', attachOnly: true, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ isReattach: true })
  await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow('managed-stop recovery')
})

it('retains unreachable legacy generations and their credentials', async () => {
  const version = PREVIOUS_DAEMON_PROTOCOL_VERSIONS[0]
  const tokenPath = getDaemonTokenPath(harness.dir, version)
  const pidPath = getDaemonPidPath(harness.dir, version)
  writeFileSync(tokenPath, 'retained-secret')
  writeFileSync(pidPath, '{unreadable pid')
  provider = createDaemonRecoveryProvider(harness.dir, join(harness.dir, 'history'))
  const legacy = provider.getAllAdapters().find((entry) => entry.protocolVersion === version)
  expect(legacy?.recoveryOnly).toBe(true)
  await expect(legacy!.listSessions()).rejects.toThrow()
  expect(readFileSync(tokenPath, 'utf8')).toBe('retained-secret')
  expect(readFileSync(pidPath, 'utf8')).toBe('{unreadable pid')
})
