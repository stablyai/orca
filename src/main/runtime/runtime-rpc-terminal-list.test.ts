import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('serves terminal.list and terminal.show for live runtime terminals', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello\n', 123)

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const listResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_list',
      authToken: metadata!.authToken,
      method: 'terminal.list',
      params: {
        worktree: 'id:repo-1::/tmp/worktree-a'
      }
    })
    expect(listResponse).toMatchObject({
      id: 'req_list',
      ok: true,
      result: {
        terminals: [expect.objectContaining({ ptyId: 'pty-1' })]
      }
    })

    const handle = (
      (
        listResponse.result as {
          terminals: { handle: string }[]
          totalCount: number
          truncated: boolean
        }
      ).terminals[0] ?? { handle: '' }
    ).handle
    expect(handle).toBeTruthy()

    const showResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_show',
      authToken: metadata!.authToken,
      method: 'terminal.show',
      params: {
        terminal: handle
      }
    })
    expect(showResponse).toMatchObject({
      id: 'req_show',
      ok: true
    })

    const readResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_read',
      authToken: metadata!.authToken,
      method: 'terminal.read',
      params: {
        terminal: handle
      }
    })
    expect(readResponse).toMatchObject({
      id: 'req_read',
      ok: true
    })

    const sendResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_send',
      authToken: metadata!.authToken,
      method: 'terminal.send',
      params: {
        terminal: handle,
        text: 'continue',
        enter: true
      }
    })
    expect(sendResponse).toMatchObject({
      id: 'req_send',
      ok: true
    })
    expect(writes).toEqual(['continue', '\r'])

    const waitPromise = sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_wait',
      authToken: metadata!.authToken,
      method: 'terminal.wait',
      params: {
        terminal: handle,
        for: 'exit',
        timeoutMs: 1000
      }
    })
    runtime.onPtyExit('pty-1', 9)
    const waitResponse = await waitPromise
    expect(waitResponse).toMatchObject({
      id: 'req_wait',
      ok: true,
      result: {
        wait: {
          handle,
          condition: 'exit',
          satisfied: true,
          status: 'exited',
          exitCode: 9
        }
      }
    })

    await server.stop()
  })

  it('serves terminal.list with visual split-group and pane nesting', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    const worktreeId = 'repo-1::/tmp/worktree-a'
    const leftLeaf = '11111111-1111-4111-8111-111111111111'
    const topLeaf = '22222222-2222-4222-8222-222222222222'
    const bottomLeaf = '33333333-3333-4333-8333-333333333333'

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-left',
          worktreeId,
          title: 'Left',
          activeLeafId: leftLeaf,
          layout: { type: 'leaf', leafId: leftLeaf }
        },
        {
          tabId: 'tab-right',
          worktreeId,
          title: 'Right',
          activeLeafId: bottomLeaf,
          layout: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: topLeaf },
            second: { type: 'leaf', leafId: bottomLeaf }
          }
        }
      ],
      leaves: [
        {
          tabId: 'tab-left',
          worktreeId,
          leafId: leftLeaf,
          paneRuntimeId: 1,
          ptyId: 'pty-left',
          title: 'Left'
        },
        {
          tabId: 'tab-right',
          worktreeId,
          leafId: topLeaf,
          paneRuntimeId: 1,
          ptyId: 'pty-top',
          title: 'Right top'
        },
        {
          tabId: 'tab-right',
          worktreeId,
          leafId: bottomLeaf,
          paneRuntimeId: 2,
          ptyId: 'pty-bottom',
          title: 'Right bottom'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: worktreeId,
          publicationEpoch: 'test',
          snapshotVersion: 1,
          activeGroupId: 'group-right',
          activeTabId: `tab-right::${bottomLeaf}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'group-left', activeTabId: 'tab-left', tabOrder: ['tab-left'] },
            { id: 'group-right', activeTabId: 'tab-right', tabOrder: ['tab-right'] }
          ],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-left' },
            second: { type: 'leaf', groupId: 'group-right' }
          },
          tabs: [
            {
              type: 'terminal',
              id: `tab-left::${leftLeaf}`,
              title: 'Left',
              parentTabId: 'tab-left',
              leafId: leftLeaf,
              ptyId: 'pty-left',
              parentLayout: {
                root: { type: 'leaf', leafId: leftLeaf },
                activeLeafId: leftLeaf,
                expandedLeafId: null,
                ptyIdsByLeafId: { [leftLeaf]: 'pty-left' }
              },
              isActive: false
            },
            {
              type: 'terminal',
              id: `tab-right::${topLeaf}`,
              title: 'Right top',
              parentTabId: 'tab-right',
              leafId: topLeaf,
              ptyId: 'pty-top',
              parentLayout: {
                root: {
                  type: 'split',
                  direction: 'vertical',
                  first: { type: 'leaf', leafId: topLeaf },
                  second: { type: 'leaf', leafId: bottomLeaf }
                },
                activeLeafId: bottomLeaf,
                expandedLeafId: null,
                ptyIdsByLeafId: {
                  [topLeaf]: 'pty-top',
                  [bottomLeaf]: 'pty-bottom'
                }
              },
              isActive: false
            },
            {
              type: 'terminal',
              id: `tab-right::${bottomLeaf}`,
              title: 'Right bottom',
              parentTabId: 'tab-right',
              leafId: bottomLeaf,
              ptyId: 'pty-bottom',
              parentLayout: {
                root: {
                  type: 'split',
                  direction: 'vertical',
                  first: { type: 'leaf', leafId: topLeaf },
                  second: { type: 'leaf', leafId: bottomLeaf }
                },
                activeLeafId: bottomLeaf,
                expandedLeafId: null,
                ptyIdsByLeafId: {
                  [topLeaf]: 'pty-top',
                  [bottomLeaf]: 'pty-bottom'
                }
              },
              isActive: true
            }
          ]
        }
      ]
    })

    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const listResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_list_layout',
        authToken: metadata!.authToken,
        method: 'terminal.list',
        params: { worktree: `id:${worktreeId}` }
      })
      const result = listResponse.result as {
        visualLayouts?: unknown[]
        terminals: { handle: string; tabId: string; leafId: string }[]
      }
      const handleByLeaf = new Map(
        result.terminals.map((terminal) => [terminal.leafId, terminal.handle])
      )

      expect(listResponse).toMatchObject({
        id: 'req_list_layout',
        ok: true
      })
      expect(result.visualLayouts).toMatchObject([
        {
          worktreeId,
          worktreePath: '/tmp/worktree-a',
          root: {
            type: 'split',
            direction: 'horizontal',
            first: {
              type: 'group',
              groupId: 'group-left',
              tabs: [
                {
                  tabId: 'tab-left',
                  panes: {
                    type: 'terminal',
                    handle: handleByLeaf.get(leftLeaf),
                    leafId: leftLeaf
                  }
                }
              ]
            },
            second: {
              type: 'group',
              groupId: 'group-right',
              tabs: [
                {
                  tabId: 'tab-right',
                  panes: {
                    type: 'pane-split',
                    direction: 'vertical',
                    first: {
                      type: 'terminal',
                      handle: handleByLeaf.get(topLeaf),
                      leafId: topLeaf
                    },
                    second: {
                      type: 'terminal',
                      handle: handleByLeaf.get(bottomLeaf),
                      leafId: bottomLeaf,
                      active: true
                    }
                  }
                }
              ]
            }
          }
        }
      ])

      // Pins the opt-out half of the compat contract: the request above omits
      // the flag and still gets layouts; only an explicit `false` drops them.
      const optedOutResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_list_layout_opt_out',
        authToken: metadata!.authToken,
        method: 'terminal.list',
        params: { worktree: `id:${worktreeId}`, includeVisualLayouts: false }
      })
      const optedOut = optedOutResponse.result as {
        visualLayouts?: unknown[]
        terminals: unknown[]
      }
      expect(optedOutResponse).toMatchObject({ id: 'req_list_layout_opt_out', ok: true })
      expect(optedOut.visualLayouts).toBeUndefined()
      expect(optedOut.terminals).toHaveLength(result.terminals.length)

      const explicitIncludeResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_list_layout_opt_in',
        authToken: metadata!.authToken,
        method: 'terminal.list',
        params: { worktree: `id:${worktreeId}`, includeVisualLayouts: true }
      })
      expect(
        (explicitIncludeResponse.result as { visualLayouts?: unknown[] }).visualLayouts
      ).toHaveLength(1)

      const resolvePaneResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_resolve_pane',
        authToken: metadata!.authToken,
        method: 'terminal.resolvePane',
        params: { paneKey: `tab-right:${bottomLeaf}`, worktreeId }
      })
      expect(resolvePaneResponse).toMatchObject({
        id: 'req_resolve_pane',
        ok: true,
        result: {
          terminal: {
            handle: handleByLeaf.get(bottomLeaf),
            tabId: 'tab-right',
            leafId: bottomLeaf,
            ptyId: 'pty-bottom',
            worktreeId
          }
        }
      })

      const wrongOwnerResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_resolve_pane_wrong_owner',
        authToken: metadata!.authToken,
        method: 'terminal.resolvePane',
        params: { paneKey: `tab-right:${bottomLeaf}`, worktreeId: 'other-worktree' }
      })
      expect(wrongOwnerResponse).toMatchObject({
        id: 'req_resolve_pane_wrong_owner',
        ok: false,
        error: { message: 'terminal_not_found' }
      })
    } finally {
      await server.stop()
    }
  })
})
