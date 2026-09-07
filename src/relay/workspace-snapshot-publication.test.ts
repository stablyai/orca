import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { relayWriterControlReserve } from './dispatcher-writer-admission'
import { encodeJsonRpcFrame, MessageType, type JsonRpcRequest } from './protocol'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import {
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  REMOTE_WORKSPACE_STALE_NOTIFICATION
} from '../shared/remote-workspace-types'

// The relay runs on the REMOTE host, so the sink default is that host's Node major.
// Node <= 21 defaults to a 16KB high-water mark, which is the 12288B capacity issue #15238 reports.
const NODE21_HWM = 16 * 1024

function decodeNotifications(
  written: Buffer[]
): { method: string; params: Record<string, unknown> }[] {
  return written
    .filter((buf) => buf[0] === MessageType.Regular)
    .map((buf) => {
      const len = buf.readUInt32BE(9)
      return JSON.parse(buf.subarray(13, 13 + len).toString('utf-8')) as {
        method?: string
        params?: Record<string, unknown>
      }
    })
    .filter(
      (msg): msg is { method: string; params: Record<string, unknown> } =>
        typeof msg.method === 'string'
    )
    .map((msg) => ({ method: msg.method, params: msg.params ?? {} }))
}

/** A session shaped like the report: several worktrees, each with a handful of tabs. */
function oversizedSession(worktrees: number, tabsPerWorktree: number): Record<string, unknown> {
  const tabsByWorktreePath: Record<string, unknown[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  for (let w = 0; w < worktrees; w++) {
    const worktreePath = `/home/dev/orca/workspaces/project/feature-branch-${w}`
    tabsByWorktreePath[worktreePath] = Array.from({ length: tabsPerWorktree }, (_, t) => ({
      id: `tab-${w}-${t}-1f7a4c2e-9b0d-4e51-8a63-2c9f0d1e4b7a`,
      title: `claude — feature-branch-${w} — pane ${t}`,
      worktreePath,
      kind: 'terminal',
      startupCommand: 'claude --dangerously-skip-permissions',
      cwd: worktreePath
    }))
    for (let t = 0; t < tabsPerWorktree; t++) {
      terminalLayoutsByTabId[`tab-${w}-${t}-1f7a4c2e-9b0d-4e51-8a63-2c9f0d1e4b7a`] = {
        direction: 'row',
        panes: [
          { id: `pane-${w}-${t}-a`, size: 50, remoteSessionId: `orca-remote-${w}-${t}-a` },
          { id: `pane-${w}-${t}-b`, size: 50, remoteSessionId: `orca-remote-${w}-${t}-b` }
        ]
      }
    }
  }
  return {
    activeWorktreePath: '/home/dev/orca/workspaces/project/feature-branch-0',
    activeTabId: 'tab-0-0-1f7a4c2e-9b0d-4e51-8a63-2c9f0d1e4b7a',
    tabsByWorktreePath,
    terminalLayoutsByTabId
  }
}

describe('workspace snapshot publication over a bounded producer frame', () => {
  let baseDir: string
  let dispatcher: RelayDispatcher
  let written: Buffer[]

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-publication-'))
    written = []
    dispatcher = new RelayDispatcher(
      (data) => {
        written.push(Buffer.from(data))
        return true
      },
      {
        writableHighWaterMark: () => NODE21_HWM,
        writableLength: () => 0,
        supportsWriteCallback: false
      }
    )
    new WorkspaceSessionHandler(dispatcher, baseDir)
  })

  afterEach(() => {
    dispatcher.dispose()
    rmSync(baseDir, { recursive: true, force: true })
  })

  async function patch(session: Record<string, unknown>, id: number): Promise<void> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method: 'workspace.patch',
      params: {
        namespace: 'ssh_host_project',
        baseRevision: id - 1,
        clientId: 'client-a',
        patch: { kind: 'replace-session', session }
      }
    }
    dispatcher.feed(encodeJsonRpcFrame(req, id, 0))
    await Promise.resolve()
    await Promise.resolve()
  }

  it('publishes the snapshot inline while it fits the producer frame', async () => {
    await patch(oversizedSession(1, 1), 1)

    const methods = decodeNotifications(written).map((msg) => msg.method)
    expect(methods).toContain(REMOTE_WORKSPACE_CHANGED_NOTIFICATION)
    expect(methods).not.toContain(REMOTE_WORKSPACE_STALE_NOTIFICATION)
  })

  it('tells the client its view is stale instead of dropping an oversized snapshot', async () => {
    const session = oversizedSession(3, 8)
    // Pin the premise: this really is over the 12288B capacity the issue reports, so the assertion
    // below measures the drop path and not a payload that happened to fit.
    const capacity = NODE21_HWM - relayWriterControlReserve(NODE21_HWM)
    expect(capacity).toBe(12288)
    expect(
      dispatcher.notificationFrameBytes(REMOTE_WORKSPACE_CHANGED_NOTIFICATION, {
        namespace: 'ssh_host_project',
        snapshot: {
          namespace: 'ssh_host_project',
          revision: 1,
          updatedAt: 0,
          schemaVersion: 1,
          session
        },
        sourceClientId: 'client-a'
      })
    ).toBeGreaterThan(capacity)

    await patch(session, 1)

    const notifications = decodeNotifications(written)
    expect(notifications.map((msg) => msg.method)).not.toContain(
      REMOTE_WORKSPACE_CHANGED_NOTIFICATION
    )
    const stale = notifications.filter((msg) => msg.method === REMOTE_WORKSPACE_STALE_NOTIFICATION)
    expect(stale).toHaveLength(1)
    expect(stale[0].params).toEqual({ namespace: 'ssh_host_project' })
  })

  it('carries no revision or author, so a coalesced marker cannot replay a superseded generation', async () => {
    const session = oversizedSession(3, 8)
    await patch(session, 1)
    written = []
    await patch({ ...session, activeTabId: 'tab-1-1-1f7a4c2e-9b0d-4e51-8a63-2c9f0d1e4b7a' }, 2)

    for (const marker of decodeNotifications(written).filter(
      (msg) => msg.method === REMOTE_WORKSPACE_STALE_NOTIFICATION
    )) {
      expect(marker.params).not.toHaveProperty('revision')
      expect(marker.params).not.toHaveProperty('sourceClientId')
      expect(marker.params).not.toHaveProperty('snapshot')
    }
  })
})
