import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../ports/advertised-url-watcher'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('never lets an old handle adopt a replacement PTY incarnation', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() })
    )
    let process = {
      id: 'reused-pty-id',
      incarnationId: 'inc-old',
      terminalHandle: 'term_old',
      title: 'old',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    }
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [process]
    })
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_old', incarnationId: 'inc-old' })]
    })

    process = { ...process, incarnationId: 'inc-new', terminalHandle: 'term_new', title: 'new' }
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_old',
            ptyId: process.id,
            incarnationId: 'inc-new',
            tabId: 'stale-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_new', incarnationId: 'inc-new' })]
    })
  })

  it('rejects ambiguous duplicate persisted bindings before idempotence', async () => {
    const duplicateTab = (id: string) => ({
      id,
      ptyId: 'duplicate-pty',
      worktreeId: TEST_WORKTREE_ID,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [duplicateTab('duplicate-a'), duplicateTab('duplicate-b')]
      },
      terminalLayoutsByTabId: {
        'duplicate-a': {
          root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
          activeLeafId: HEADLESS_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'duplicate-pty' }
        },
        'duplicate-b': {
          root: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID },
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_SECOND_LEAF_ID]: 'duplicate-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`duplicate-a:${HEADLESS_LEAF_ID}`]: 'inc-duplicate',
        [`duplicate-b:${HEADLESS_SECOND_LEAF_ID}`]: 'inc-duplicate'
      }
    })
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() })
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'duplicate-pty',
          incarnationId: 'inc-duplicate',
          terminalHandle: 'term_duplicate',
          title: 'duplicate',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_duplicate',
            ptyId: 'duplicate-pty',
            incarnationId: 'inc-duplicate',
            tabId: 'duplicate-a',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('does not adopt a discovered terminal handle already bound to another live PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writesByPty = new Map<string, string[]>()
    runtime.setPtyController({
      write: (ptyId, data) => {
        writesByPty.set(ptyId, [...(writesByPty.get(ptyId) ?? []), data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-victim',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        },
        {
          id: 'pty-imposter',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    const handles = listed.terminals.map((terminal) => terminal.handle)
    expect(handles).toContain('term_victim')
    expect(new Set(handles).size).toBe(handles.length)

    await expect(
      runtime.sendTerminal('term_victim', { text: 'for victim' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writesByPty.get('pty-victim')).toEqual(['for victim'])
    expect(writesByPty.has('pty-imposter')).toBe(false)
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(
      runtime.sendTerminal(handle, { text: 'still writable' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('preserves PTY process identity while a renderer surface detaches and reattaches', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({
        id: 'pty-bg',
        incarnationId: 'incarnation-bg'
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const [tabId, leafId] = created.paneKey?.split(':') ?? []
    if (!tabId || !leafId) {
      throw new Error('expected stable pane identity')
    }
    const syncSurface = (ptyId: string | null): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId,
            paneTitle: 'Codex'
          }
        ]
      })
    }

    syncSurface('pty-bg')
    await runtime.listTerminals()
    const before = runtime.getTerminalProcessIncarnation(created.handle)
    syncSurface(null)
    syncSurface('pty-bg')
    await runtime.listTerminals()

    expect(runtime.getTerminalProcessIncarnation(created.handle)).toBe(before)

    runtime.registerPty('pty-bg', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-replacement'
    })
    expect(runtime.getTerminalProcessIncarnation(created.handle)).not.toBe(before)
  })
})
