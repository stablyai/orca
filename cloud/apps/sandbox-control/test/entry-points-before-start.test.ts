// ENTRY-POINTS-BEFORE-START: a boot from an environment build made on an older golden ran that golden's
// orca-sandbox-start (no agent prefetch, no OpenCode first run) until the environment was rebuilt.
// refreshRuntime's one command also probes the entry points; older ones are installed before the start.
import { describe, expect, it, vi } from 'vitest'
import { VM_SCRIPTS_STAMP } from '../image/vm-scripts.generated'
import { entryPointsBehind } from '../src/golden-images'
import { refreshRuntime, type LifecycleDeps } from '../src/lifecycle'
import type { SandboxRow } from '../src/store'

type Call = { args?: string[]; env?: Record<string, string> }

function setup(probe: string, plan: boolean) {
  const calls: Call[] = []
  const runCommand = vi.fn(async (_session: string, call: Call) => {
    calls.push(call)
    return calls.length === 1 ? { exitCode: 0, stdout: `${probe}\n${plan ? 'current abc' : ''}`, stderr: '' } : { exitCode: 0, stdout: 'synced\n', stderr: '' }
  })
  const deps = {
    provider: { runCommand },
    now: () => 0,
    runtimeRefresh: async () => (plan ? { bundle: { commit: 'abc', sha256: 'f', runtime: '22' }, url: 'https://x' } : null)
  } as unknown as LifecycleDeps
  const row = { id: 'sbx_1', region: 'iad1' } as unknown as SandboxRow
  return { calls, deps, row }
}

describe('ENTRY-POINTS-BEFORE-START', () => {
  it('installs older entry points before the start, in the same round trip as the runtime check', async () => {
    const t = setup(`stamp=${VM_SCRIPTS_STAMP - 1}\nmarker=0`, true)
    await expect(refreshRuntime(t.deps, t.row, 'sess')).resolves.toBe('current abc')
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0]!.args!.at(-1)).toContain('stamp=')
    expect(t.calls[0]!.args!.at(-1)).toContain('SOURCE_COMMIT')
    expect(t.calls[1]!.args!.at(-1)).toContain('install -o root')
  })

  it('adds nothing when the image carries this Worker scripts (same stamp or marker)', async () => {
    for (const probe of [`stamp=${VM_SCRIPTS_STAMP}\nmarker=0`, 'stamp=0\nmarker=1']) {
      const t = setup(probe, true)
      await refreshRuntime(t.deps, t.row, 'sess')
      expect(t.calls).toHaveLength(1)
    }
  })

  it('still probes without a runtime bundle, and never downgrades a newer image', async () => {
    const t = setup(`stamp=${VM_SCRIPTS_STAMP - 1}\nmarker=0`, false)
    await expect(refreshRuntime(t.deps, t.row, 'sess')).resolves.toBe('no_bundle')
    expect(t.calls).toHaveLength(2)
    expect(entryPointsBehind({ stamp: VM_SCRIPTS_STAMP + 1, marker: false })).toBe(false)
    expect(entryPointsBehind(null)).toBe(false)
  })
})
