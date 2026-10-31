import { app } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TeamRegistry, readTeamJson } from '../project-teams/project-team-config'
import { ProjectTeamService, type TeamRoleResult } from '../project-teams/project-team-service'
import { savedTeamTabs } from '../project-teams/project-team-pane'
import { listReferenceWorkspaces } from '../runtime/runtime-reference-catalog'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { mainProcessState as state } from './main-process-state'

/** Only explicitly imported profile/app bindings activate teams; arbitrary repository files do not. */
export async function startProjectTeams(): Promise<void> {
  const runtime = state.runtime
  const store = state.store
  if (!runtime || !store || state.isServeMode) {
    return
  }
  const profile = app.getPath('userData')
  const registryFile = join(profile, 'project-teams.json')
  try {
    await readFile(registryFile)
  } catch {
    return
  }
  const dispatcher = new RpcDispatcher({ runtime })
  const workspaces = async () => listReferenceWorkspaces(store)
  const service = new ProjectTeamService({
    profile,
    workspaces,
    existingTabs: (worktreeId) => savedTeamTabs(store.getWorkspaceSession(), worktreeId),
    call: async (method, params) => {
      const response = await dispatcher.dispatch({
        id: randomUUID(),
        authToken: 'local-project-team',
        method,
        params
      })
      if (!response.ok) {
        throw new Error(response.error.code)
      }
      return response.result
    }
  })
  let watchers: FSWatcher[] = []
  let pending = false
  let running = false
  let stopped = false
  const reload = async (): Promise<void> => {
    if (stopped) {
      return
    }
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      do {
        pending = false
        const registry = TeamRegistry.parse(await readTeamJson(registryFile))
        for (const watcher of watchers) {
          watcher.close()
        }
        watchers = []
        const configs = registry.teams.map((t) =>
          isAbsolute(t.config) ? t.config : resolve(dirname(registryFile), t.config)
        )
        for (const file of [registryFile, ...configs]) {
          try {
            watchers.push(
              watch(dirname(file), { persistent: false }, (_event, filename) => {
                if (filename?.toString() === basename(file)) {
                  void reload().catch(report)
                }
              })
            )
          } catch {
            /* Missing configs are reported by the ordinary load below. */
          }
        }
        const catalog = await workspaces()
        const results: {
          config: string
          projectRoot?: string
          code?: string
          roles: TeamRoleResult[]
        }[] = []
        for (const [index, entry] of registry.teams.entries()) {
          let projectRoot = entry.projectRoot
          if (projectRoot.startsWith('workspace:')) {
            const name = projectRoot.slice('workspace:'.length)
            const matches = catalog.filter(
              (w) => (!w.hostId || w.hostId === 'local') && w.name === name
            )
            if (matches.length !== 1) {
              results.push({
                config: configs[index],
                code: 'team_workspace_binding_required',
                roles: []
              })
              continue
            }
            projectRoot = matches[0].path
          }
          try {
            const roles = await service.ensure({ ...entry, config: configs[index], projectRoot })
            results.push({ config: configs[index], projectRoot, roles })
          } catch {
            results.push({
              config: configs[index],
              projectRoot,
              code: 'team_config_load_failed',
              roles: []
            })
          }
        }
        await writeFile(
          join(profile, 'project-team-runtime.json'),
          JSON.stringify(
            {
              version: 1,
              runtimeId: runtime.getRuntimeId(),
              checkedAt: new Date().toISOString(),
              teams: results
            },
            null,
            2
          )
        )
        console.info(
          '[project-teams] configuration loaded',
          results.map((t) => ({
            roles: t.roles.length,
            blocked: t.roles.filter((r) => r.status === 'blocked').length
          }))
        )
      } while (pending && !stopped)
    } finally {
      running = false
    }
  }
  const report = (): void => {
    console.warn('[project-teams] configuration could not be applied; check project-teams.json')
  }
  app.once('before-quit', () => {
    stopped = true
    for (const watcher of watchers) {
      watcher.close()
    }
  })
  await state.localPtyStartupReady
  await reload().catch(report)
}
