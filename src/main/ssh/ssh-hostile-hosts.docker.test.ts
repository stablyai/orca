// Design D5/D6 hostile-host matrix: the real client-side relay deploy against container SSH
// targets, and against a macOS runner's own loopback sshd, asserting which rung of the runtime
// ladder each host lands on, and for cells naming one, the runtime managed orcad deploys on.
//
// Run: ORCA_RUN_SSH_HOSTILE_HOSTS=1 pnpm test src/main/ssh/ssh-hostile-hosts.docker.test.ts
// Needs `pnpm build:relay` and an orcad template holding each selected cell's slot. Docker cells
// need Linux Docker (the no-egress cell dials an internal bridge directly) and
//   node config/scripts/build-orcad-template.mjs --targets linux-x64-glibc,linux-x64-musl
// macOS cells need /usr/sbin/sshd and this runner's slot (`pnpm build:orcad-prebuilds`, then
// `--targets darwin-arm64` or `darwin-x64`). Only cells this machine can host run.
// ORCA_SSH_HOSTILE_HOST_CELLS=id,id narrows the run. .github/workflows/ssh-hostile-hosts.yml runs it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { HOSTILE_HOST_CELLS, selectHostileHostCells } from './ssh-hostile-host-cells'
import { proveManagedOrcadCell } from './ssh-hostile-host-managed-orcad'
import { installHostileHostAppEnvironment } from './ssh-hostile-host-test-harness'
import {
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

describe('SSH hostile-host managed orcad matrix', () => {
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

  // A fresh host per cell.
  for (const cell of HOSTILE_HOST_CELLS.filter((candidate) => candidate.managed)) {
    it.skipIf(!SELECTED.has(cell.id))(
      `${cell.id} deploys managed orcad on ${cell.managed?.runtime} (${cell.managed?.outcome})`,
      async () => {
        let target: HostileHostTarget | null = null
        try {
          target = await startHostileHostTarget(cell)
          await proveManagedOrcadCell(cell, target, hostileHostSshTarget(target))
        } finally {
          await stopHostileHostTarget(target)
        }
      },
      CELL_TIMEOUT_MS
    )
  }
})
