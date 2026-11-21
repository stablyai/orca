import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ dataDirectory: '' }))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => host.dataDirectory
}))

// A fresh module per test: whether launch has read the releases is module state.
async function detection() {
  vi.resetModules()
  const install = await import('./managed-copy-detection')
  const { readInstalledManagedAgents } =
    await import('../../../../preflight/managed-agent-detection')
  const { rememberManagedAgentRelease } =
    await import('../../../../managed-agent-cli/managed-agent-cli-registry')
  return { ...install, readInstalledManagedAgents, rememberManagedAgentRelease }
}

const settingsOf = (settings: Record<string, unknown>) => ({
  requireStore: () => ({ getSettings: () => settings })
})

async function installed(folder: string): Promise<void> {
  const release = join(host.dataDirectory, 'agent-runtimes', folder, '1.0')
  await mkdir(release, { recursive: true })
  await writeFile(join(release, '.install-complete.json'), '{}')
}

beforeEach(async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-detect-'))
})
afterEach(() => rm(host.dataDirectory, { recursive: true, force: true }))

it("counts Orca's installed copies before launch has read its releases, without waiting for it", async () => {
  await installed('grok')
  const { provideManagedAgentDetection, readInstalledManagedAgents } = await detection()
  provideManagedAgentDetection(settingsOf({}))

  expect(await readInstalledManagedAgents()).toEqual(['grok'])
})

it('counts only the managed agy installation and omits it while switched off', async () => {
  await installed('antigravity')
  const { provideManagedAgentDetection, readInstalledManagedAgents } = await detection()
  const settings = { antigravityManagedAgyEnabled: true }
  provideManagedAgentDetection(settingsOf(settings))
  expect(await readInstalledManagedAgents()).toEqual([])

  await installed('agy')
  expect(await readInstalledManagedAgents()).toEqual(['antigravity'])

  settings.antigravityManagedAgyEnabled = false
  expect(await readInstalledManagedAgents()).toEqual([])
})

it('uses remembered releases after the launch read and skips a refresh when they match', async () => {
  await installed('grok')
  const {
    provideManagedAgentDetection,
    noteManagedReleasesRead,
    readInstalledManagedAgents,
    rememberManagedAgentRelease
  } = await detection()
  const { onAgentsRefreshedOnHost } = await import('../../../../preflight/agents-refreshed-on-host')
  const refreshed = vi.fn()
  onAgentsRefreshedOnHost(refreshed)
  provideManagedAgentDetection(settingsOf({}))
  expect(await readInstalledManagedAgents()).toEqual(['grok'])
  rememberManagedAgentRelease('grok', join(host.dataDirectory, 'agent-runtimes', 'grok', '1.0'))
  noteManagedReleasesRead()
  expect(refreshed).not.toHaveBeenCalled()
  expect(await readInstalledManagedAgents()).toEqual(['grok'])

  // Removed: the receipt is still on disk, but the remembered release is gone.
  rememberManagedAgentRelease('grok', null)
  expect(await readInstalledManagedAgents()).toEqual([])
})

it('announces a copy the disk check counted that the launch read found unusable', async () => {
  await installed('grok')
  const { provideManagedAgentDetection, noteManagedReleasesRead, readInstalledManagedAgents } =
    await detection()
  const { onAgentsRefreshedOnHost } = await import('../../../../preflight/agents-refreshed-on-host')
  const refreshed = vi.fn()
  onAgentsRefreshedOnHost(refreshed)
  provideManagedAgentDetection(settingsOf({}))
  await readInstalledManagedAgents()

  noteManagedReleasesRead()

  expect(refreshed).toHaveBeenCalled()
})

it('never fails startup or detection when the settings store is unavailable', async () => {
  await installed('grok')
  const { provideManagedAgentDetection, noteManagedReleasesRead, readInstalledManagedAgents } =
    await detection()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let storeReady = true
  provideManagedAgentDetection({
    requireStore: () => {
      if (!storeReady) {
        throw new Error('store not ready')
      }
      return { getSettings: () => ({}) }
    }
  })
  expect(await readInstalledManagedAgents()).toEqual(['grok'])

  storeReady = false
  // Launch reclaim compares what the disk check counted; a failing store must not fail it.
  expect(() => noteManagedReleasesRead()).not.toThrow()
  expect(await readInstalledManagedAgents()).toEqual([])
})
