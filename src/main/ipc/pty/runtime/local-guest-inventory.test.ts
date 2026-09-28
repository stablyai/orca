import { afterEach, expect, it, vi } from 'vitest'
import { createUnavailablePtyProvider } from '../../../providers/unavailable-pty-provider'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import {
  getLocalPtyProvider,
  registerSshPtyProvider,
  registerWslPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from '../provider/registry'
import { ptyOwnership } from '../provider/ownership-state'
import {
  listProcessesFromRuntimeController,
  listProcessesWithHostScopeFromRuntimeController
} from './inventory-operations'
import { supportsForegroundProcessEvidenceFromRuntimeController } from './foreground-process-evidence-capability'

const releases: (() => void)[] = []
const original = getLocalPtyProvider()
afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
  unregisterSshPtyProvider('remote')
  setLocalPtyProvider(original)
  ptyOwnership.clear()
})
const ubuntu = { distro: 'Ubuntu', relayBuildId: 'build+user1' }
const debian = { distro: 'Debian', relayBuildId: 'build+user2' }
const row = (id: string) => ({
  id,
  cwd: '/folder with spaces',
  title: 'shell',
  worktreeId: 'folder-project'
})
function setup() {
  const nativeList = vi.fn(async () => [row('pty2:windows:1')])
  const firstList = vi.fn(async () => [row(toAppWslPtyId(ubuntu, 'pty2:guest:1'))])
  const secondList = vi.fn(async () => [row(toAppWslPtyId(debian, 'pty2:guest:1'))])
  const provider = (listProcesses: typeof nativeList) => ({
    ...createUnavailablePtyProvider(),
    listProcesses,
    supportsForegroundProcessEvidence: vi.fn(async () => true)
  })
  setLocalPtyProvider(provider(nativeList))
  releases.push(registerWslPtyProvider(ubuntu, provider(firstList)))
  const second = provider(secondList)
  releases.push(registerWslPtyProvider(debian, second))
  const sshList = vi.fn(async () => [row('ssh:remote@@pty2:remote:1')])
  registerSshPtyProvider('remote', provider(sshList))
  return { nativeList, firstList, secondList, sshList, second }
}

it('local scope includes native and both guest owners without touching SSH or rewriting folder identity', async () => {
  const { sshList } = setup()
  const rows = await listProcessesFromRuntimeController({}, null)
  expect(rows.map((entry) => entry.id)).toEqual([
    'pty2:windows:1',
    toAppWslPtyId(ubuntu, 'pty2:guest:1'),
    toAppWslPtyId(debian, 'pty2:guest:1')
  ])
  expect(
    rows.every(
      (entry) => entry.cwd === '/folder with spaces' && entry.worktreeId === 'folder-project'
    )
  ).toBe(true)
  expect(sshList).not.toHaveBeenCalled()
})

it('failed guest removes local absence authority while retaining successful rows and SSH authority', async () => {
  const { secondList } = setup()
  secondList.mockRejectedValue(new Error('guest disconnected'))
  const id = toAppWslPtyId(debian, 'pty2:guest:1')
  ptyOwnership.set(id, null)
  const runtime = { markPtyLivenessUnverifiable: vi.fn() }
  const snapshot = await listProcessesWithHostScopeFromRuntimeController({ runtime })
  expect(snapshot.processes.map((entry) => entry.id)).toEqual([
    'pty2:windows:1',
    'ssh:remote@@pty2:remote:1',
    toAppWslPtyId(ubuntu, 'pty2:guest:1')
  ])
  expect(snapshot.hostIds).toEqual(['ssh:remote'])
  expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(id, 'guest disconnected')
  await expect(listProcessesFromRuntimeController({ runtime }, null)).rejects.toThrow(
    'unverifiable'
  )
})

it('persisted split binding fences local authority even after its disconnected provider leaves the registry', async () => {
  setup()
  releases.pop()?.()
  const id = toAppWslPtyId(debian, 'pty2:guest:1')
  const session = getDefaultWorkspaceSession()
  session.terminalLayoutsByTabId.tab = {
    root: { type: 'leaf', leafId: 'leaf' },
    activeLeafId: 'leaf',
    expandedLeafId: null,
    ptyIdsByLeafId: { leaf: id }
  }
  const store = { getWorkspaceSession: () => session }
  const runtime = { markPtyLivenessUnverifiable: vi.fn() }
  const snapshot = await listProcessesWithHostScopeFromRuntimeController({ store, runtime })
  expect(snapshot.hostIds).not.toContain('local')
  expect(snapshot.processes).toHaveLength(3)
  expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
    id,
    expect.stringContaining('not connected')
  )
  await expect(listProcessesFromRuntimeController({ store, runtime }, null)).rejects.toThrow(
    'unverifiable'
  )
  expect(await listProcessesFromRuntimeController({ store, runtime }, 'remote')).toHaveLength(1)
})

it('guest capabilities participate in local projection and failures return false', async () => {
  const { second } = setup()
  expect(await supportsForegroundProcessEvidenceFromRuntimeController(null)).toBe(true)
  second.supportsForegroundProcessEvidence.mockRejectedValue(new Error('offline'))
  expect(await supportsForegroundProcessEvidenceFromRuntimeController(null)).toBe(false)
  expect(await supportsForegroundProcessEvidenceFromRuntimeController()).toBe(false)
})

it.each(['disconnect', 'replace', 'reject'] as const)(
  'does not grant local absence authority when a guest changes during inventory: %s',
  async (transition) => {
    const { secondList } = setup()
    const id = toAppWslPtyId(debian, 'pty2:guest:1')
    ptyOwnership.set(id, null)
    const runtime = { markPtyLivenessUnverifiable: vi.fn() }
    let finish = () => {}
    secondList.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = () =>
            transition === 'reject'
              ? reject(new Error('query lost after disconnect'))
              : resolve([row(id)])
        })
    )
    const pending = listProcessesWithHostScopeFromRuntimeController({ runtime })
    releases.pop()?.()
    if (transition === 'replace') {
      releases.push(registerWslPtyProvider(debian, createUnavailablePtyProvider()))
    }
    finish()
    const snapshot = await pending
    expect(snapshot.hostIds).toEqual(['ssh:remote'])
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(id, expect.any(String))
  }
)

it('rejects array-only local inventory if a new guest registers while queries are pending', async () => {
  const { secondList } = setup()
  let finish = () => {}
  secondList.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([])
      })
  )
  const pending = listProcessesFromRuntimeController({}, null)
  releases.push(
    registerWslPtyProvider(
      { distro: 'Fedora', relayBuildId: 'build+user3' },
      createUnavailablePtyProvider()
    )
  )
  finish()
  await expect(pending).rejects.toThrow('unverifiable')
})
