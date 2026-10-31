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
  const recorded: {
    site: string
    armed: boolean
    child: Parameters<typeof OrphanGuard.guardSupervisedProviderGroup>[0]
    report: Parameters<typeof OrphanGuard.guardSupervisedProviderGroup>[1]['report']
    proven: boolean
    swept?: string
  }[] = []
  return { registrations: recorded }
})

vi.mock('./provider-group-orphan-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof OrphanGuard>()
  return {
    ...actual,
    guardSupervisedProviderGroup: (
      ...args: Parameters<typeof actual.guardSupervisedProviderGroup>
    ) => {
      const registration = {
        site: args[1].site,
        armed: false,
        child: args[0],
        report: args[1].report,
        proven: false,
        swept: ''
      }
      registration.armed = actual.guardSupervisedProviderGroup(args[0], {
        ...args[1],
        onProven: (identity) => {
          registration.proven = true
          args[1].onProven?.(identity)
        },
        onSwept: (verdict) => {
          registration.swept = verdict
          args[1].onSwept?.(verdict)
        }
      })
      registrations.push(registration)
      return registration.armed
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
  it('Codex app-server sessions, whose adapter re-maps the spawn options', async () => {
    await runCodexAppServerSession(
      { command: process.execPath, cliPath: null, args: QUICK_EXIT, timeoutMs: 2_000 },
      async () => null
    ).catch(() => null)
    expect(registrations).toMatchObject([{ site: expect.any(String), armed: true }])
  })

  it.each(['managed', 'backfill', 'preflight', 'text-generation'] as const)(
    '%s commits/ACKs, proves the actual group, and completes naturally',
    async (site) => {
      const release = join(dir, `${site}-release`)
      const program = join(dir, `${site}-agent`)
      writeFileSync(
        program,
        `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stdin.resume();\nprocess.stdout.write('received output');\nconst timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0) } }, 10);\n`
      )
      chmodSync(program, 0o755)
      let completion: Promise<unknown> | undefined
      let output = ''
      let child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once'> | undefined
      try {
        if (site === 'managed') {
          const managed = spawnManagedProviderProcess({ command: program, args: [] }, { site })
          child = managed.child
          managed.child.stdout.on('data', (bytes) => {
            output += String(bytes)
          })
        } else if (site === 'backfill') {
          child = spawnCodexBackfillRecoveryProcess(
            dir,
            spawnCodexAppServerProcess,
            () => program
          ).child
        } else if (site === 'preflight') {
          completion = probeOpenCodeLaunchModelContext({
            executable: program,
            cwd: dir,
            env: process.env
          })
        } else {
          const launched = spawnSourceControlAgent({
            binary: program,
            args: [],
            env: process.env,
            stdinMode: 'pipe',
            useCwdForNative: false
          })
          launched.stdin?.end()
          launched.stdout?.on('data', (bytes) => {
            output += String(bytes)
          })
          child = launched
        }
        await vi.waitFor(() => expect(registrations).toHaveLength(1))
        const registration = registrations[0]
        expect(registration.armed).toBe(true)
        expect(await registration.report?.done).toMatchObject({
          kind: 'spawned',
          pgid: expect.any(Number)
        })
        await vi.waitFor(() => expect(registration.proven).toBe(true), { timeout: 5_000 })
        await registration.report?.closed
        // Receipt ACK closes only its own descriptor; the real provider is still held by the barrier.
        expect(registration.swept).toBe('')
        writeFileSync(release, '')
        await Promise.all([completion, child && exited(child)])
        await vi.waitFor(() => expect(registration.swept).toBe('absent'))
        if (child) {
          expect(child.exitCode).toBe(0)
        }
        if (site === 'managed' || site === 'text-generation') {
          expect(output).toBe('received output')
        }
      } finally {
        // Always release the exact child started by this test, including on failed assertions.
        writeFileSync(release, '')
        await Promise.all([completion, child && exited(child)])
      }
    },
    15_000
  )
})
