import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: unknown) => unknown
const { handlers, connect, getPath } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  connect: vi.fn(),
  getPath: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath },
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: vi.fn()
  }
}))
vi.mock('../ephemeral-vm/runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connect,
  disconnectRuntimeOwnedSshTarget: vi.fn(async () => {}),
  removeRuntimeOwnedSshTarget: vi.fn(async () => {})
}))
vi.mock('./runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn()
}))

import type { Store } from '../persistence/loading-store/store'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { registerEphemeralVmHandlers } from './ephemeral-vm'
import { suspendEphemeralVmWorkspace } from '../ephemeral-vm/workspace-suspend'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const sshResult = {
  schemaVersion: 1,
  connection: {
    type: 'ssh',
    projectRoot: '/workspace/repo',
    target: { label: 'Sandbox', host: 'sandbox.example.com', port: 22, username: 'root' }
  }
}

function setupManagedSshRecipe(): { userDataPath: string; store: Store } {
  const userDataPath = tempDir('orca-vm-managed-user-data-')
  const repoPath = tempDir('orca-vm-managed-repo-')
  getPath.mockReturnValue(userDataPath)
  const script = (name: string, body: string): string => {
    const scriptPath = join(repoPath, name)
    writeFileSync(scriptPath, body)
    return JSON.stringify(`"${process.execPath}" "${scriptPath}"`)
  }
  const printResult = `console.log(${JSON.stringify(JSON.stringify(sshResult))})`
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      `    create: ${script('start.js', printResult)}`,
      `    suspend: ${script('suspend.js', '')}`,
      `    resume: ${script('resume.js', printResult)}`,
      '    destroy: none'
    ].join('\n')
  )
  connect.mockReset()
  connect.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => ({
    targetId: `runtime-ssh-${runtimeId}`,
    target: { id: `runtime-ssh-${runtimeId}` },
    environmentId: 'env-managed-vm'
  }))
  const repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only getRepo, getRepos and getSettings.
  const store = {
    getRepo: (id: string) => (id === repo.id ? repo : null),
    getRepos: () => [repo],
    getSettings: () => ({})
  } as unknown as Store
  registerEphemeralVmHandlers(store)
  return { userDataPath, store }
}

async function provision(): Promise<unknown> {
  return handlers.get('ephemeralVm:provision')?.(null, {
    repoId: 'repo-1',
    recipeId: 'cloud-sandbox'
  })
}

it("reconnects a resumed VM's SSH host instead of asking for a pairing code", async () => {
  const { userDataPath, store } = setupManagedSshRecipe()
  const provisioned = await provision()
  const [runtime] = listEphemeralVmRuntimes(userDataPath)
  expect(provisioned).toMatchObject({ ok: true, runtime: { id: runtime.id } })
  const runtimeId = runtime.id
  await handlers.get('ephemeralVm:attachWorkspace')?.(null, { runtimeId, workspaceId: 'ws-1' })
  await suspendEphemeralVmWorkspace(store, 'ws-1')
  connect.mockClear()

  const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, { workspaceId: 'ws-1' })

  expect(connect).toHaveBeenCalledTimes(1)
  expect(resumed).toMatchObject({
    status: 'running',
    connectionMode: 'ssh',
    runtimeEnvironmentId: 'env-managed-vm'
  })
})
