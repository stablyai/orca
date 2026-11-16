// image/vm/gh run for real (bash): without the control plane's switch or an agent turn it is plain gh.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const WRAPPER = fileURLToPath(new URL('../image/vm/gh', import.meta.url).href)
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-gh-'))
  dirs.push(root)
  const wrapperDir = join(root, 'orca-bin')
  const realDir = join(root, 'usr-bin')
  mkdirSync(wrapperDir)
  mkdirSync(realDir)
  copyFileSync(WRAPPER, join(wrapperDir, 'gh'))
  chmodSync(join(wrapperDir, 'gh'), 0o755)
  writeFileSync(join(realDir, 'gh'), '#!/usr/bin/env bash\necho "real gh token=$GH_TOKEN args=$*"\n')
  chmodSync(join(realDir, 'gh'), 0o755)
  return (env: Record<string, string>) =>
    execFileSync(join(wrapperDir, 'gh'), ['pr', 'create', '--fill'], {
      env: { PATH: `${wrapperDir}:${realDir}:/usr/bin:/bin`, GH_TOKEN: 'orca-ph-sbx_workspace', ...env },
      encoding: 'utf8'
    }).trim()
}

describe('VM gh wrapper (GH-AS-MEMBER)', () => {
  it('finds the real gh past itself and runs it as before when the switch is off or no agent turn is known', () => {
    const run = scratch()
    expect(run({})).toBe('real gh token=orca-ph-sbx_workspace args=pr create --fill')
    // On, but not in an agent turn: still the workspace identity.
    expect(run({ ORCA_GH_AS_MEMBER: 'on' })).toBe('real gh token=orca-ph-sbx_workspace args=pr create --fill')
  })

  it('an agent turn whose sender can’t be attested falls back to the workspace identity, never fails', () => {
    const run = scratch()
    // No sudo rule / orca-git-identity here: the attestation fails and gh runs as the workspace.
    expect(run({ ORCA_GH_AS_MEMBER: 'on', ORCA_AGENT_SESSION_ID: 's1' })).toBe('real gh token=orca-ph-sbx_workspace args=pr create --fill')
  })
})
