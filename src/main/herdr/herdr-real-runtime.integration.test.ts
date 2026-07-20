import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, TerminalTab } from '../../shared/types'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import { HerdrRuntimeManager } from './herdr-runtime-manager'

const herdrBinary = process.env.ORCA_HERDR_BINARY
const runRealHerdr = herdrBinary ? describe : describe.skip
const configHome = mkdtempSync(path.join(os.tmpdir(), 'orca-herdr-runtime-'))
const sessionName = `orca-integration-${process.pid}`

afterEach(() => {
  if (herdrBinary) {
    try {
      execFileSync(herdrBinary, ['session', 'stop', sessionName, '--json'], {
        stdio: 'ignore',
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      })
    } catch {
      // The session may not exist when setup fails.
    }
  }
  rmSync(configHome, { recursive: true, force: true })
})

runRealHerdr('real Herdr runtime graph', () => {
  it(
    'reconciles one Orca tab from one pane to a persistent split',
    async () => {
      const project: Project = {
        id: 'project-real',
        displayName: 'Real Herdr',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-real'],
        herdrSessionName: sessionName,
        createdAt: 1,
        updatedAt: 1
      }
      const worktreeId = `repo-real::${configHome}`
      const tab: TerminalTab = {
        id: 'tab-real',
        ptyId: null,
        worktreeId,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
      const transport = new HerdrCliHostTransport({
        commandFor: localHerdrCommand(herdrBinary!),
        timeoutMs: 30_000
      })
      const manager = new HerdrRuntimeManager(transport)
      const graph = {
        project,
        worktrees: [
          {
            id: worktreeId,
            instanceId: 'worktree-real',
            path: configHome,
            displayName: 'main'
          }
        ],
        tabsByWorktreeId: { [worktreeId]: [tab] },
        layoutsByTabId: {
          [tab.id]: {
            root: { type: 'leaf' as const, leafId: 'leaf-a' },
            activeLeafId: 'leaf-a',
            expandedLeafId: null
          }
        }
      }

      const initial = await manager.reconcileProjectHost(graph)
      expect(initial.panes.filter((pane) => pane.external_ref?.owner === 'orca')).toHaveLength(1)

      const split = await manager.reconcileProjectHost({
        ...graph,
        layoutsByTabId: {
          [tab.id]: {
            root: {
              type: 'split',
              direction: 'vertical',
              ratio: 0.5,
              first: { type: 'leaf', leafId: 'leaf-a' },
              second: { type: 'leaf', leafId: 'leaf-b' }
            },
            activeLeafId: 'leaf-b',
            expandedLeafId: null
          }
        }
      })

      expect(split.tabs.filter((candidate) => candidate.external_ref?.owner === 'orca')).toHaveLength(1)
      expect(split.panes.filter((pane) => pane.external_ref?.owner === 'orca')).toHaveLength(2)
      manager.dispose()
    },
    60_000
  )
})
