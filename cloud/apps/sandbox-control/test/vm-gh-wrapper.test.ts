// image/vm/gh run for real (bash): without the control plane's switch or an agent turn it is plain gh.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GH_WRAPPER_LAYOUT } from '../src/golden-images'

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

  it('the VM layout: tools/bin/gh (first on PATH) links to the wrapper, which runs the off-PATH real gh, never itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-vm-gh-layout-'))
    dirs.push(root)
    for (const dir of ['bin', 'tools/bin', 'tools/gh/bin']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    copyFileSync(WRAPPER, join(root, 'bin/gh'))
    chmodSync(join(root, 'bin/gh'), 0o755)
    symlinkSync('../../bin/gh', join(root, 'tools/bin/gh'))
    writeFileSync(join(root, 'tools/gh/bin/gh'), '#!/usr/bin/env bash\necho "real gh token=$GH_TOKEN args=$*"\n')
    chmodSync(join(root, 'tools/gh/bin/gh'), 0o755)
    const out = execFileSync('gh', ['pr', 'view'], {
      env: { PATH: `${root}/tools/bin:${root}/bin:/usr/bin:/bin`, ORCA_HOME: root, GH_TOKEN: 'orca-ph-sbx_workspace' },
      encoding: 'utf8',
      timeout: 10_000
    }).trim()
    expect(out).toBe('real gh token=orca-ph-sbx_workspace args=pr view')
  })

  it('with no off-PATH real gh, a PATH search through the link skips the wrapper itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-vm-gh-link-'))
    dirs.push(root)
    for (const dir of ['bin', 'tools/bin', 'usr-bin']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    copyFileSync(WRAPPER, join(root, 'bin/gh'))
    chmodSync(join(root, 'bin/gh'), 0o755)
    symlinkSync('../../bin/gh', join(root, 'tools/bin/gh'))
    writeFileSync(join(root, 'usr-bin/gh'), '#!/usr/bin/env bash\necho "real gh args=$*"\n')
    chmodSync(join(root, 'usr-bin/gh'), 0o755)
    const out = execFileSync('gh', ['auth', 'status'], {
      env: { PATH: `${root}/tools/bin:${root}/bin:${root}/usr-bin:/usr/bin:/bin`, ORCA_HOME: root },
      encoding: 'utf8',
      timeout: 10_000
    }).trim()
    expect(out).toBe('real gh args=auth status')
  })

  it('an older image is moved to that layout at entry-point install, once (idempotent)', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-vm-gh-migrate-'))
    dirs.push(root)
    for (const dir of ['bin', 'tools/bin']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    copyFileSync(WRAPPER, join(root, 'bin/gh'))
    writeFileSync(join(root, 'tools/bin/gh'), '#!/usr/bin/env bash\necho real\n')
    chmodSync(join(root, 'tools/bin/gh'), 0o755)
    for (let i = 0; i < 2; i++) {
      execFileSync('bash', ['-c', GH_WRAPPER_LAYOUT], { env: { PATH: '/usr/bin:/bin', ORCA_HOME: root, SUDO: '' } })
    }
    expect(lstatSync(join(root, 'tools/bin/gh')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(root, 'tools/bin/gh'))).toBe('../../bin/gh')
    expect(execFileSync(join(root, 'tools/gh/bin/gh'), { encoding: 'utf8' }).trim()).toBe('real')
  })
})
