import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { isClosedPaneFenced } from '../../../persistence/terminal-topology/pane-ownership/closed-pane-binding-fence'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../layout/runtime-layout-apply'

const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SIBLING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE = `tab_r:${LEAF}`

/** The command run the layout writer receives from main. */
class LayoutCommandRunProbe extends OrcaRuntimeService {
  commandRun(command: WindowLayoutCommand): LayoutCommandRunOptions | undefined {
    return this.layoutCommandRun(command)
  }
}

// Only main stops a restarted pane's terminal before its write; the switch-off build has no such stop.
describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('a pane restarted in place', () => {
  it('keeps its pane when the old terminal exits after the restart stopped it', async () => {
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt: [
          {
            id: 'tab_r',
            ptyId: 'pty-old',
            worktreeId: 'wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab_r: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: SIBLING }
          },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-old', [SIBLING]: 'pty-sibling' }
        }
      }
    }
    const store = withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getSettings: () => ({}),
      flushOrThrow: () => undefined
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries every store method a pane exit reaches.
    const runtime = new LayoutCommandRunProbe(store as never)
    runtime.registerPty('pty-old', 'wt', null, { tabId: 'tab_r', leafId: LEAF })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: kill is the only controller call the restart's stop makes.
    runtime.setPtyController({ kill: () => true } as never)
    const run = runtime.commandRun({
      type: 'restartPane',
      workspace: 'wt',
      tabId: 'tab_r',
      paneKey: PANE
    })

    expect(run?.stopBeforeWrite?.(['pty-old'])).toBe(true)
    // The killed shell's exit lands after the stop, before the replacement binds.
    await runtime.onPtyExit('pty-old', 0)

    expect(collectLeafIds(session.terminalLayoutsByTabId.tab_r?.root)).toEqual([LEAF, SIBLING])
    expect(isClosedPaneFenced(PANE)).toBe(false)
  })
})
