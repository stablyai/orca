import { expect, it } from 'vitest'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import { finalizeWindowsLocalPtySpawnEnvironment } from './local-pty-windows-spawn-environment'

function finalize(env: Record<string, string>): Record<string, string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a PowerShell pane without CODEX_HOME reads only shellPath from the plan.
  const plan = { shellPath: 'C:\\Windows\\System32\\powershell.exe' } as LocalPtyLaunchPlan
  finalizeWindowsLocalPtySpawnEnvironment({ spawn: { cols: 80, rows: 24 }, plan, env })
  return env
}

it('exports the pane handle and its runtime source to child WSL tools (#49580)', () => {
  const env = finalize({
    ORCA_TERMINAL_HANDLE: 'term_a',
    ORCA_RUNTIME_SOURCE_ID: 'install-1',
    ORCA_RUNTIME_SOURCE_INCARNATION: 'runtime-1',
    WSLENV: 'FOO/u'
  })

  expect(env.WSLENV?.split(':')).toEqual([
    'FOO/u',
    'ORCA_TERMINAL_HANDLE/u',
    'ORCA_RUNTIME_SOURCE_ID/u',
    'ORCA_RUNTIME_SOURCE_INCARNATION/u'
  ])
})
