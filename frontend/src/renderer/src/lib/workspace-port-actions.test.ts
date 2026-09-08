import { afterEach, describe, expect, it, vi } from 'vitest'
import { killWorkspacePortForTarget, mergeWorkspacePortScans } from './workspace-port-actions'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'

function makePort(id: string, port: number): WorkspacePort {
  return {
    id,
    kind: 'external',
    bindHost: '0.0.0.0',
    connectHost: '127.0.0.1',
    port,
    protocol: 'http'
  }
}

function makeScan(ports: WorkspacePort[], scannedAt = 1): WorkspacePortScanResult {
  return { platform: 'linux', scannedAt, ports }
}

describe('mergeWorkspacePortScans', () => {
  it('returns null when there are no scans', () => {
    expect(mergeWorkspacePortScans({})).toBeNull()
  })

  it('returns the single scan unchanged when only one exists', () => {
    const scan = makeScan([makePort('tcp:3000', 3000)])
    expect(mergeWorkspacePortScans({ local: scan })).toBe(scan)
  })

  it('merges multiple scans, prefixing port ids by scan key', () => {
    const result = mergeWorkspacePortScans({
      local: makeScan([makePort('tcp:3000', 3000)], 1),
      'runtime:env-1': makeScan([makePort('tcp:4000', 4000)], 2)
    })
    expect(result?.ports.map((p) => p.id)).toEqual(['local:tcp:3000', 'runtime:env-1:tcp:4000'])
    expect(result?.scannedAt).toBe(2)
  })

  // Regression test: a scan result whose own fetch failed/hasn't completed
  // can carry `ports` as null/undefined at runtime despite
  // WorkspacePortScanResult declaring it a required array — found live
  // crashing the whole Ports panel (`Cannot read properties of null
  // (reading 'map')`) on the first scan triggered right after creating a
  // project.
  it('tolerates a scan result with ports missing instead of throwing', () => {
    const brokenScan = { platform: 'linux', scannedAt: 1 } as unknown as WorkspacePortScanResult
    const result = mergeWorkspacePortScans({
      local: makeScan([makePort('tcp:3000', 3000)]),
      broken: brokenScan
    })
    expect(result?.ports.map((p) => p.id)).toEqual(['local:tcp:3000'])
  })
})

// BUG-016: killWorkspacePortForTarget must carry worktreeId on the wire
// whenever the caller has one (WorkspacePortOwner.worktreeId), alongside
// repoId — a repo can own several worktrees, so repoId alone is ambiguous
// for the backend's connectionId resolution.
describe('killWorkspacePortForTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCache()
  })

  it('sends worktreeId alongside repoId for a local target', async () => {
    const kill = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', {
      api: { workspacePorts: { kill } }
    })

    const result = await killWorkspacePortForTarget(
      { kind: 'local' },
      { repoId: 'repo-1', worktreeId: 'wt-1', pid: 123, port: 3000 }
    )

    expect(result).toEqual({ ok: true })
    expect(kill).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      pid: 123,
      port: 3000
    })
  })

  it('sends worktreeId alongside repoId for a remote environment target', async () => {
    const runtimeEnvironmentCall = vi.fn().mockResolvedValue({ ok: true, result: { ok: true } })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeEnvironmentCall } }
    })
    markRuntimeEnvironmentCompatible('env-1')

    const result = await killWorkspacePortForTarget(
      { kind: 'environment', environmentId: 'env-1' },
      { repoId: 'repo-1', worktreeId: 'wt-1', pid: 123, port: 3000 }
    )

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'workspacePorts.kill',
      params: { repoId: 'repo-1', worktreeId: 'wt-1', pid: 123, port: 3000 },
      timeoutMs: 15_000
    })
  })

  it('omits worktreeId when the caller does not have one', async () => {
    const kill = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', {
      api: { workspacePorts: { kill } }
    })

    await killWorkspacePortForTarget({ kind: 'local' }, { repoId: 'repo-1', pid: 123, port: 3000 })

    expect(kill).toHaveBeenCalledWith({ repoId: 'repo-1', pid: 123, port: 3000 })
  })
})
