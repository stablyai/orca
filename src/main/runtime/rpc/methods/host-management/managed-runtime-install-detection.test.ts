import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ dataDirectory: '' }))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => host.dataDirectory
}))

const { provideManagedAgentDetection } = await import('./managed-runtime-install')
const { readInstalledManagedAgents } = await import('../../../../preflight/managed-agent-detection')

afterEach(() => rm(host.dataDirectory, { recursive: true, force: true }))

it("counts Orca's installed copies before launch has read its releases, without waiting for it", async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-detect-before-reclaim-'))
  const release = join(host.dataDirectory, 'agent-runtimes', 'grok', '1.0')
  await mkdir(release, { recursive: true })
  await writeFile(join(release, '.install-complete.json'), '{}')
  const runtime = { requireStore: () => ({ getSettings: () => ({}) }) }
  provideManagedAgentDetection(runtime)

  expect(await readInstalledManagedAgents()).toEqual(['grok'])
})
