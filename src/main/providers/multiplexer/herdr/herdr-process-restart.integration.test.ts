import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import { localHerdrCommand } from './herdr-cli-session'
import { configHomeDir } from './herdr-stock-binary'
import { ORCA_BINDING_TOKEN } from './herdr-binding-metadata'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import { herdrServerEnvironment } from './herdr-cli-session'
import { HerdrSocketTransport } from './herdr-socket-transport'
import { resolveStockHerdrTestBinary } from './herdr-stock-binary'
import type { Project } from '../../../../shared/project-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const binary = resolveStockHerdrTestBinary()
const describeRealHerdr = binary ? describe : describe.skip

describeRealHerdr('stock Herdr process restart', () => {
  const configHome = configHomeDir()
  const sessionName = `ot-${process.pid}`
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: configHome }
  for (const name of Object.keys(env)) {
    if (name.startsWith('HERDR_')) {
      delete env[name]
    }
  }
  const socketPath = join(configHome, '.config/herdr/sessions', sessionName, 'herdr.sock')
  const transport = new HerdrSocketTransport({
    sessionName,
    socketPath,
    commandFor: localHerdrCommand(binary as string, env),
    serverCommandFor: (name) => ({
      file: binary as string,
      args: ['--session', name, 'server'],
      env: herdrServerEnvironment(env)
    }),
    timeoutMs: 30_000
  })
  const manager = new HerdrRuntimeManager(transport, () => sessionName)

  afterAll(async () => {
    try {
      execFileSync(binary as string, ['session', 'stop', sessionName, '--json'], {
        env,
        stdio: 'ignore',
        timeout: 30_000
      })
    } catch {
      // Session never started.
    }
    await transport.disconnect()
    rmSync(configHome, { recursive: true, force: true })
  })

  it('restarts a dead stock server and reconverges the same Orca bindings', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['repo-1'],
      herdrSessionName: sessionName,
      createdAt: 1,
      updatedAt: 1
    }
    const tab: TerminalTab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'worktree-1',
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const graph = {
      project,
      worktrees: [{ id: 'worktree-1', path: configHome, displayName: 'repo' }],
      tabsByWorktreeId: { 'worktree-1': [tab] },
      layoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            ratio: 0.5,
            first: { type: 'leaf' as const, leafId: 'leaf-1' },
            second: { type: 'leaf' as const, leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      }
    }

    const first = await manager.reconcileProjectHost(graph)
    expect(first.workspaces).toHaveLength(1)
    expect(first.panes.filter((pane) => pane.tokens?.[ORCA_BINDING_TOKEN])).toHaveLength(2)
    const firstWorkspaceId = first.workspaces[0].workspace_id
    const session = herdrSessionNameForProject(project, sessionName)
    const firstLeaf1 = manager.getPaneId(session, project.id, 'leaf-1')
    const firstLeaf2 = manager.getPaneId(session, project.id, 'leaf-2')
    expect(firstLeaf1).toBeTruthy()
    expect(firstLeaf2).toBeTruthy()

    execFileSync(binary as string, ['session', 'stop', sessionName, '--json'], {
      env,
      stdio: 'ignore',
      timeout: 30_000
    })
    expect(existsSync(socketPath)).toBe(false)

    await transport.ensureSession(sessionName)
    const restored = unwrapHerdrResponse<{ snapshot: typeof first }>(
      await transport.request(sessionName, 'session.snapshot', {})
    ).snapshot

    const second = await manager.reconcileProjectHost(graph)
    expect(second.workspaces).toHaveLength(1)
    expect(second.workspaces[0].workspace_id).toBe(firstWorkspaceId)
    expect(manager.getPaneId(session, project.id, 'leaf-1')).toBe(firstLeaf1)
    expect(manager.getPaneId(session, project.id, 'leaf-2')).toBe(firstLeaf2)
    expect(
      second.workspaces.filter((workspace) => workspace.tokens?.[ORCA_BINDING_TOKEN])
    ).toHaveLength(1)
    expect(restored.workspaces).toHaveLength(1)
  }, 60_000)
})
