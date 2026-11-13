/** STA-1840 regression: known blank-terminal handles request a bounded renderer mount. */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

export function registerTerminalMobileSubscribeTabMountTests(): void {
  type HandleSeed = {
    handle: string
    worktreeId: string
    tabId: string
    ptyId: string | null
  }

  type RuntimeInternals = {
    handles: Map<
      string,
      HandleSeed & {
        runtimeId: string
        rendererGraphEpoch: number
        leafId: string
        ptyGeneration: number
      }
    >
    getAuthoritativeWindow: () => {
      webContents: { send: (channel: string, payload: unknown) => void }
    }
    leaves: Map<string, unknown>
    issueHandle: (leaf: unknown) => string
  }

  describe('mobile terminal subscribe tab mount', () => {
    it('keeps a waiting real-tab handle usable when the mount binds its first PTY', async () => {
      const runtime = new OrcaRuntimeService()
      const syncGraph = async (ptyId: string | null): Promise<void> => {
        await runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              title: 'Terminal',
              activeLeafId: 'leaf-1',
              layout: null
            }
          ],
          leaves: [
            {
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              leafId: 'leaf-1',
              paneRuntimeId: 1,
              ptyId
            }
          ]
        })
      }

      runtime.attachWindow(1)
      syncGraph(null)
      const internals = runtime as unknown as RuntimeInternals
      const leaf = internals.leaves.values().next().value
      if (!leaf) {
        throw new Error('expected terminal leaf')
      }
      const handle = internals.issueHandle(leaf)
      const ptyWait = runtime.waitForLeafPtyId(handle)

      syncGraph('pty-1')

      await expect(ptyWait).resolves.toBe('pty-1')
      expect(runtime.resolveLiveLeafForHandle(handle)).toEqual({ ptyId: 'pty-1' })
      await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ handle })
    })
  })
}
