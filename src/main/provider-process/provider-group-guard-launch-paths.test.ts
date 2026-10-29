import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OrphanGuard from './provider-group-orphan-guard'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { spawnCodexAppServerProcess } from '../codex/codex-app-server-process-tree-kill'
import { spawnCodexBackfillRecoveryProcess } from '../codex/codex-state-db-backfill-recovery-process'
import { probeOpenCodeLaunchModelContext } from '../opencode/opencode-launch-model-context'
import { spawnSourceControlAgent } from '../text-generation/source-control-agent-launch'

// Adapters that rewrite stdio can silently drop the supervisor group-report channel.

const { registrations } = vi.hoisted(() => {
  const recorded: { site: string; armed: boolean }[] = []
  return { registrations: recorded }
})

vi.mock('./provider-group-orphan-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof OrphanGuard>()
  return {
    ...actual,
    guardSupervisedProviderGroup: (
      ...args: Parameters<typeof actual.guardSupervisedProviderGroup>
    ) => {
      const armed = actual.guardSupervisedProviderGroup(...args)
      registrations.push({ site: args[1].site, armed })
      return armed
    }
  }
})

const dir = mkdtempSync(join(tmpdir(), 'orca-guard-launch-paths-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// Exit promptly so supervisors relay the outcome and stop without test cleanup.
const QUICK_EXIT = ['-e', 'setTimeout(() => {}, 50)']

function exited(child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once'>): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()))
}

beforeEach(() => {
  registrations.length = 0
})

describe.runIf(process.platform !== 'win32')('provider group guard on every launch path', () => {
  it('managed provider processes (Codex, Claude, ACP, JSON-lines, model catalog)', async () => {
    const managed = spawnManagedProviderProcess(
      { command: process.execPath, args: QUICK_EXIT },
      { site: 'managed' }
    )
    expect(registrations).toEqual([{ site: 'managed', armed: true }])
    await managed.close()
  })

  it('Codex app-server sessions, whose adapter re-maps the spawn options', async () => {
    await runCodexAppServerSession(
      { command: process.execPath, cliPath: null, args: QUICK_EXIT, timeoutMs: 2_000 },
      async () => null
    ).catch(() => null)
    expect(registrations).toEqual([{ site: expect.any(String), armed: true }])
  })

  it('the Codex backfill recovery app-server', async () => {
    const { child } = spawnCodexBackfillRecoveryProcess(
      dir,
      spawnCodexAppServerProcess,
      () => process.execPath
    )
    expect(registrations).toEqual([{ site: 'codex-state-db-backfill-recovery', armed: true }])
    await exited(child)
  })

  it('the OpenCode launch-context probe', async () => {
    const standIn = join(dir, 'opencode')
    writeFileSync(standIn, '#!/bin/sh\nexit 0\n')
    chmodSync(standIn, 0o755)
    await probeOpenCodeLaunchModelContext({ executable: standIn, cwd: dir, env: process.env })
    expect(registrations).toEqual([{ site: 'opencode-launch-model-preflight', armed: true }])
  })

  it('source-control text generation', async () => {
    const child = spawnSourceControlAgent({
      binary: process.execPath,
      args: QUICK_EXIT,
      env: process.env,
      stdinMode: 'pipe',
      useCwdForNative: false
    })
    expect(registrations).toEqual([{ site: 'source-control-text-generation', armed: true }])
    child.stdin?.end()
    await exited(child)
  })
})
