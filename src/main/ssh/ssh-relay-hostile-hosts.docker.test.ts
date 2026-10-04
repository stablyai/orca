// Design D5/D6 hostile-host matrix: the real client-side relay deploy against container SSH
// targets, and against a macOS runner's own loopback sshd, asserting which rung of the runtime
// ladder each host lands on.
//
// Run: ORCA_RUN_SSH_HOSTILE_HOSTS=1 pnpm test src/main/ssh/ssh-relay-hostile-hosts.docker.test.ts
// Needs `pnpm build:relay` and an orcad template holding each selected cell's slot. Docker cells
// need Linux Docker (the no-egress cell dials an internal bridge directly) and
//   node config/scripts/build-orcad-template.mjs --targets linux-x64-glibc,linux-x64-musl
// macOS cells need /usr/sbin/sshd and this runner's slot (`pnpm build:orcad-prebuilds`, then
// `--targets darwin-arm64` or `darwin-x64`). Only cells this machine can host run.
// ORCA_SSH_HOSTILE_HOST_CELLS=id,id narrows the run. .github/workflows/ssh-hostile-hosts.yml runs it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { posix } from 'node:path'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { HOSTILE_HOST_CELLS, selectHostileHostCells } from './ssh-hostile-host-cells'
import {
  assertCell,
  connectHostileHost,
  deployOnce,
  exerciseLaunchedCell,
  installHostileHostAppEnvironment,
  TERMINAL_PROBES
} from './ssh-hostile-host-test-harness'
import {
  hostExec,
  hostExecStatus,
  hostileHostObserver,
  hostileHostSshTarget,
  startHostileHostTarget,
  stopHostileHostTarget,
  type HostileHostTarget
} from './ssh-hostile-host-test-fixture'

const RUN = process.env.ORCA_RUN_SSH_HOSTILE_HOSTS === '1'
const SELECTED = new Set(
  RUN ? selectHostileHostCells(process.env.ORCA_SSH_HOSTILE_HOST_CELLS).map((cell) => cell.id) : []
)
const CELL_TIMEOUT_MS = 15 * 60_000

/**
 * Gatekeeper only evaluates files carrying com.apple.quarantine, which SFTP writes never get; the
 * runtime must run as uploaded, with no `xattr -d` (the SSH side's xattr is a forbidden shim).
 */
async function assertRunsWithoutQuarantine(
  target: HostileHostTarget,
  nodePath: string
): Promise<void> {
  const runtimeDir = posix.dirname(posix.dirname(nodePath))
  expect(await hostExec(target, `xattr -r -l '${runtimeDir}'`)).not.toContain(
    'com.apple.quarantine'
  )
  expect(await hostExec(target, `'${nodePath}' -p process.version`)).toBe(
    `v${NODE_RUNTIME_PIN.version}`
  )
}

describe('SSH relay hostile-host matrix', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  // Why: with every cell skipped the job would pass having deployed nothing.
  it.runIf(RUN)('selects at least one cell this machine can host', () => {
    expect(SELECTED.size).toBeGreaterThan(0)
  })

  for (const cell of HOSTILE_HOST_CELLS) {
    it.skipIf(!SELECTED.has(cell.id))(
      `${cell.id} lands on ${cell.expect.outcome === 'launched' ? `rung ${cell.expect.rung}` : cell.expect.outcome}`,
      async () => {
        let target: HostileHostTarget | null = null
        let conn: SshConnection | null = null
        try {
          target = await startHostileHostTarget(cell)
          if (target.kind === 'docker' && target.cell.noEgress) {
            expect(
              await hostExecStatus(target, "timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'")
            ).not.toBe(0)
          }
          const observer = hostileHostObserver(target)
          const sshTarget = hostileHostSshTarget(target)
          conn = await connectHostileHost(sshTarget)
          const first = await deployOnce(conn)
          await assertCell(cell, observer, first)
          if (cell.expect.outcome === 'launched') {
            const launched = await exerciseLaunchedCell({
              cell,
              observer,
              sshTarget,
              terminal: TERMINAL_PROBES.posix,
              first,
              firstConn: conn
            })
            if (target.kind === 'local-sshd' && target.cell.runsOn.platform === 'darwin') {
              await assertRunsWithoutQuarantine(target, launched.nodePath)
            }
          } else if (
            cell.expect.outcome !== 'legacy_opt_out' &&
            cell.expect.refusals[0]?.reason === 'libc_floor'
          ) {
            // Refused from the probe alone: nothing was uploaded.
            expect(
              await hostExecStatus(target, 'ls -d /root/.orca-remote/runtimes/node-*')
            ).not.toBe(0)
          }
        } finally {
          await conn?.disconnect().catch(() => {})
          await stopHostileHostTarget(target)
        }
      },
      CELL_TIMEOUT_MS
    )
  }
})
