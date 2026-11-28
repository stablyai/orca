/**
 * Issue #8450 — SSH relay selects system Node without npm instead of NVM.
 *
 * resolveRemoteNodePath accepts the first Node that meets the major-version
 * gate. It never probes companion `npm` in that Node's bin dir. The path-probe
 * script lists `command -v node` first, so `/usr/bin/node` (Ubuntu package
 * without npm) wins before NVM candidates. installNativeDeps then does
 * `export PATH=<nodeBinDir>:$PATH && npm install …` → exit 127.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ssh/repro-8450-node-without-npm.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { commandWithNodePath } from './ssh-remote-commands'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { resolveRemoteNodePath } = await import('./ssh-remote-node-resolution')

const conn = {} as SshConnection

describe('issue #8450 SSH node resolution ignores missing npm', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('accepts system node that only satisfies the version gate (no npm check)', async () => {
    // Path probe returns system node first (command -v node), then NVM.
    // Only the first candidate is version-checked when it succeeds.
    execCommandMock
      .mockResolvedValueOnce(
        `${['/usr/bin/node', '/home/user/.nvm/versions/node/v22.22.0/bin/node'].join('\n')}\n`
      )
      .mockResolvedValueOnce('v18.19.1\n') // version only — no npm probe

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/bin/node')

    // Version check only — never `command -v npm` or sibling npm --version.
    expect(execCommandMock).toHaveBeenCalledTimes(2)
    const versionCmd = String(execCommandMock.mock.calls[1]![1])
    expect(versionCmd).toMatch(/node.*--version|\/usr\/bin\/node/)
    expect(versionCmd).not.toMatch(/npm/)
  })

  it('source path-probe lists command -v node before NVM globs and never requires npm', () => {
    const source = readFileSync(join(__dirname, 'ssh-remote-node-resolution.ts'), 'utf8')
    const commandVNodeIdx = source.indexOf('command -v node 2>/dev/null')
    const nvmGlobIdx = source.indexOf('"$nvm_dir"/versions/node/*/bin/node')
    expect(commandVNodeIdx).toBeGreaterThan(-1)
    expect(nvmGlobIdx).toBeGreaterThan(commandVNodeIdx)

    // Acceptance is node --version major only (error guidance may mention npm).
    expect(source).toMatch(/nodeMeetsVersionRequirement/)
    expect(source).toMatch(/MIN_NODE_MAJOR\s*=\s*18/)
    expect(source).not.toMatch(/npmMeets|hasNpm|command -v npm/)
    // No function that validates companion npm beside the accepted node binary.
    const acceptanceSlice = source.slice(
      source.indexOf('async function nodeMeetsVersionRequirement'),
      source.indexOf('async function resolveRemoteWindowsNodePath')
    )
    expect(acceptanceSlice).toMatch(/--version/)
    expect(acceptanceSlice).not.toMatch(/npm/)
  })

  it('commandWithNodePath prepends selected node bin dir then runs bare npm', () => {
    const host = { os: 'linux' as const, shell: 'bash' }
    const cmd = commandWithNodePath(
      host,
      '/usr/bin/node',
      '/home/u/.orca-remote/relay',
      'npm install'
    )
    expect(cmd).toContain("export PATH='/usr/bin':$PATH")
    expect(cmd).toContain('npm install')
    // Mirrors the failure: PATH has node dir but no npm binary there.
  })

  it('installNativeDeps invokes npm without verifying companion npm exists', () => {
    const deploy = readFileSync(join(__dirname, 'ssh-relay-deploy.ts'), 'utf8')
    expect(deploy).toMatch(/npm install --omit=dev --no-audit --no-fund/)
    expect(deploy).toMatch(/commandWithNodePath|export PATH/)
    // No preflight that skips incomplete toolchains.
    expect(deploy).not.toMatch(/command -v npm/)
  })
})
