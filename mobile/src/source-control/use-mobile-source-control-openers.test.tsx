import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const route = vi.hoisted(() => {
  const opened: unknown[] = []
  return {
    opened,
    router: {
      push: (href: unknown) => opened.push(['push', href]),
      replace: (href: unknown) => opened.push(['replace', href]),
      navigate: (href: unknown) => opened.push(['navigate', href]),
      back: () => opened.push(['back'])
    }
  }
})

vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => route.router }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSelection: vi.fn() }))

import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'

const ENTRY = { path: 'src/app.ts', status: 'modified', area: 'unstaged' } as const

const META = { runtimeId: 'runtime-1' }

async function tapChangedFile(args: {
  executionHost?: string
  openDiffReply: RpcResponse
  unmountDuringOpen?: boolean
}): Promise<{ methods: string[]; actionErrors: (string | null)[]; openedDiffs: string[] }> {
  route.opened.length = 0
  const methods: string[] = []
  const actionErrors: (string | null)[] = []
  const openedDiffs: string[] = []
  const mountedRef = { current: true }
  const sendRequest = async (method: string): Promise<RpcResponse> => {
    methods.push(method)
    if (args.unmountDuringOpen) {
      mountedRef.current = false
    }
    return args.openDiffReply
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener reaches `sendRequest` and nothing else on the client.
  const client = { sendRequest } as RpcClient
  const held: { openFile: ((entry: typeof ENTRY) => Promise<void>) | null } = { openFile: null }
  function Probe(): null {
    held.openFile = useMobileSourceControlOpeners({
      client,
      connState: 'connected',
      hostId: 'host-1',
      worktreeId: 'wt',
      name: 'api',
      origin: 'session',
      embedded: false,
      onOpenedFileDiff: (path) => openedDiffs.push(path),
      branchCompareState: { kind: 'idle' },
      mountedRef,
      busyActionRef: { current: null },
      setActionError: (message) => actionErrors.push(message)
    }).openFile
    return null
  }
  await act(async () => {
    create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: normalizeExecutionHostId(args.executionHost) ?? undefined },
        createElement(Probe)
      )
    )
  })
  await act(async () => {
    await held.openFile?.(ENTRY)
  })
  return { methods, actionErrors, openedDiffs }
}

describe('tapping a changed file from the session', () => {
  it("opens a server workspace's diff on the review screen when its host has no desktop window", async () => {
    const result = await tapChangedFile({
      executionHost: 'runtime:vm',
      openDiffReply: {
        id: 'call',
        ok: false,
        error: { code: 'runtime_error', message: 'renderer_unavailable' },
        _meta: META
      }
    })
    expect(result.methods).toEqual(['files.openDiff'])
    expect(route.opened).toEqual([
      [
        'push',
        '/h/host-1/review/wt?scope=all&file=src%2Fapp.ts&area=unstaged&name=api&executionHost=runtime%3Avm'
      ]
    ])
    expect(result.actionErrors).toEqual([null])
    expect(result.openedDiffs).toEqual([])
  })

  it('does not push the review screen once the source control screen has gone during the call', async () => {
    const result = await tapChangedFile({
      executionHost: 'runtime:vm',
      unmountDuringOpen: true,
      openDiffReply: {
        id: 'call',
        ok: false,
        error: { code: 'runtime_error', message: 'renderer_unavailable' },
        _meta: META
      }
    })
    expect(result.methods).toEqual(['files.openDiff'])
    expect(route.opened).toEqual([])
  })

  it("opens a local workspace's diff as a desktop tab", async () => {
    const result = await tapChangedFile({
      openDiffReply: { id: 'call', ok: true, result: {}, _meta: META }
    })
    expect(result.methods).toEqual(['files.openDiff'])
    expect(result.openedDiffs).toEqual(['src/app.ts'])
    expect(route.opened).toEqual([['back']])
    expect(result.actionErrors).toEqual([null])
  })
})
