import { expect, it, vi } from 'vitest'
import { runtimeEnvironmentsApi } from './runtime-environments-bridge'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))
it('routes live migration listing and explicit resume through distinct desktop channels', async () => {
  const selection = { selector: 'host', migrationId: 'migration', mode: 'recovery' as const }
  const result = { sourceRetirement: 'pending' }
  invoke.mockResolvedValue(result)
  await expect(runtimeEnvironmentsApi.listOrcadLiveMigrations({ selector: 'host' })).resolves.toBe(
    result
  )
  await expect(runtimeEnvironmentsApi.resumeOrcadLiveMigration(selection)).resolves.toBe(result)
  const start = { selector: 'host', targetId: 'target' }
  await expect(runtimeEnvironmentsApi.startOrcadLiveMigration(start)).resolves.toBe(result)
  const planSelection = { selector: 'host', migrationId: 'migration' }
  await expect(
    runtimeEnvironmentsApi.getOrcadLiveMigrationRendererPlan(planSelection)
  ).resolves.toBe(result)
  expect(invoke.mock.calls).toEqual([
    ['runtimeEnvironments:listOrcadLiveMigrations', { selector: 'host' }],
    ['runtimeEnvironments:resumeOrcadLiveMigration', selection],
    ['runtimeEnvironments:startOrcadLiveMigration', start],
    ['runtimeEnvironments:getOrcadLiveMigrationRendererPlan', planSelection]
  ])
})
