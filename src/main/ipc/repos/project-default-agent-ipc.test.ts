import { expect, it } from 'vitest'
import { ProjectUpdateIpcArgs } from './repo-ipc-arg-schemas'

it('preserves a Windows Git choice in WSL alongside the project agent default', () => {
  const updates = {
    defaultTuiAgent: 'codex',
    localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
  }
  expect(ProjectUpdateIpcArgs.parse({ projectId: 'project-b', updates }).updates).toEqual(updates)
})

it('preserves the project default through the local IPC update schema', () => {
  expect(
    ProjectUpdateIpcArgs.parse({
      projectId: 'project-b',
      updates: { defaultTuiAgent: 'codex' }
    }).updates
  ).toEqual({ defaultTuiAgent: 'codex' })
  expect(
    ProjectUpdateIpcArgs.parse({
      projectId: 'project-b',
      updates: { defaultTuiAgent: null }
    }).updates
  ).toEqual({ defaultTuiAgent: null })
  expect(
    ProjectUpdateIpcArgs.safeParse({
      projectId: 'project-b',
      updates: { defaultTuiAgent: 'unknown-agent' }
    }).success
  ).toBe(false)
})
