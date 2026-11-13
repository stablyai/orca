// PARITY-AUTO-ENV-DEPS: an automatic environment installs the first repo's JavaScript dependencies
// from its lockfile, so creates start warm, and never fails its build over it. The real script's
// auto_install, run by a real bash against a scratch repo with stub package managers on PATH.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VM_SCRIPTS } from '../image/golden-image'
import { ENVIRONMENT_BUILD_SCRIPT } from '../image/vm-scripts.generated'

const script = readFileSync(fileURLToPath(new URL('../image/env/environment-build.sh', import.meta.url).href), 'utf8')
const autoInstall = /^auto_install\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0]

let dir: string
let repo: string
let bin: string

/** A stub command that logs its argv to calls.log and exits with $STUB_<NAME>_EXIT (default 0). */
function stub(name: string): void {
  const exitVar = `STUB_${name.toUpperCase()}_EXIT`
  writeFileSync(
    join(bin, name),
    `#!/usr/bin/env bash\necho "${name} $*" >>"${join(dir, 'calls.log')}"\n` +
      // A failing install leaves a half-written tree behind, as real ones do.
      `mkdir -p node_modules/.half packages/a/node_modules\nexit "\${${exitVar}:-0}"\n`
  )
  chmodSync(join(bin, name), 0o755)
}

function run(env: Record<string, string> = {}): { status: number; out: string; calls: string } {
  const program = ['set -uo pipefail', autoInstall, 'auto_install "$REPO"', 'echo "status:$?"'].join('\n')
  let out: string
  let status = 0
  try {
    out = execFileSync('bash', ['--noprofile', '--norc', '-c', program], {
      env: { PATH: `${bin}:${process.env.PATH}`, REPO: repo, ...env },
      encoding: 'utf8'
    })
  } catch (error) {
    const failed = error as { status: number; stdout: string }
    status = failed.status
    out = failed.stdout
  }
  const log = join(dir, 'calls.log')
  return { status, out, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-auto-install-'))
  repo = join(dir, 'repo')
  bin = join(dir, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  stub('corepack')
  stub('npm')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = (path: string, content = ''): void => writeFileSync(join(repo, path), content)

describe('environment-build.sh auto_install (PARITY-AUTO-ENV-DEPS)', () => {
  it('is in the build script, runs only for automatic environments without an install script, and ships in the Worker', () => {
    expect(autoInstall).toBeDefined()
    expect(script).toMatch(/elif \[ "\$\{ORCA_AUTO_INSTALL:-\}" = 1 \] && \[ -n "\$first" \]; then\n {2}auto_install "\$first"\n/)
    expect(ENVIRONMENT_BUILD_SCRIPT).toBe(script)
    // env/ scripts ride in the Worker, not among the golden's VM scripts (so they never need a rotation).
    expect(VM_SCRIPTS as readonly string[]).not.toContain('environment-build.sh')
  })

  it('picks the package manager from the lockfile, frozen, through corepack', () => {
    file('package.json', '{"name":"web"}')
    file('pnpm-lock.yaml')
    const pnpm = run()
    expect(pnpm.out).toContain('status:0')
    expect(pnpm.calls).toBe('corepack pnpm install --frozen-lockfile\n')
    expect(pnpm.out).toMatch(/Installed dependencies in \d+s\./)
  })

  it('yarn berry is --immutable, classic --frozen-lockfile; npm is npm ci', () => {
    file('package.json', '{}')
    file('yarn.lock')
    expect(run().calls).toBe('corepack yarn install --frozen-lockfile\n')
    rmSync(join(dir, 'calls.log'))
    file('.yarnrc.yml', 'nodeLinker: node-modules\n')
    expect(run().calls).toBe('corepack yarn install --immutable\n')
    rmSync(join(repo, 'yarn.lock'))
    rmSync(join(repo, '.yarnrc.yml'))
    rmSync(join(dir, 'calls.log'))
    file('package-lock.json', '{}')
    expect(run().calls).toBe('npm ci\n')
  })

  it("package.json's packageManager wins over the lockfile guess", () => {
    file('package.json', '{"name":"web","packageManager":"pnpm@9.12.0"}')
    file('package-lock.json', '{}')
    expect(run().calls).toBe('corepack pnpm install --frozen-lockfile\n')
  })

  it('a failed install (often a lockfile out of date) never fails the build and leaves no half-installed tree', () => {
    file('package.json', '{}')
    file('pnpm-lock.yaml')
    const failed = run({ STUB_COREPACK_EXIT: '1' })
    expect(failed.status).toBe(0)
    expect(failed.out).toContain('status:0')
    expect(failed.out).toContain('Automatic install skipped: corepack pnpm install --frozen-lockfile exited with status 1')
    expect(failed.out).toContain('New workspaces start from the cloned repo and run their own setup.')
    expect(existsSync(join(repo, 'node_modules'))).toBe(false)
    expect(existsSync(join(repo, 'packages/a/node_modules'))).toBe(false)
  })

  it('stops at the time cap and says so, still without failing', () => {
    file('package.json', '{}')
    file('package-lock.json', '{}')
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nsleep 5\n')
    chmodSync(join(bin, 'npm'), 0o755)
    const slow = run({ ORCA_AUTO_INSTALL_TIMEOUT: '1' })
    expect(slow.out).toContain('status:0')
    expect(slow.out).toContain('took longer than 15 minutes')
  })

  it('names what the image cannot install, and does nothing without a lockfile', () => {
    file('uv.lock')
    file('Gemfile.lock')
    const others = run()
    expect(others.calls).toBe('')
    expect(others.out).toContain('Not installed automatically: uv.lock Gemfile.lock.')
    rmSync(join(repo, 'uv.lock'))
    rmSync(join(repo, 'Gemfile.lock'))
    const none = run()
    expect(none.calls).toBe('')
    expect(none.out).toContain('No lockfile found; the build keeps the cloned repos.')
  })
})
