import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { windowsSecurityAddonOutput } from './build-windows-security-addon.mjs'
import { stageOrcadWindowsSecurity } from './orcad-windows-security.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function peBytes(machine) {
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orcad-windows-security-'))
  roots.push(root)
  const output = join(root, 'output')
  mkdirSync(output)
  const write = (arch, machine) => {
    const source = windowsSecurityAddonOutput(root, arch)
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, peBytes(machine))
    return source
  }
  return { root, output, write }
}

it('stages the addon for each Windows architecture after checking its machine', () => {
  const { root, output, write } = fixture()
  const x64 = write('x64', 0x8664)
  stageOrcadWindowsSecurity(root, output, 'win32-x64')
  expect(readFileSync(join(output, 'windows-security.node'))).toEqual(readFileSync(x64))

  const arm64 = write('arm64', 0xaa64)
  stageOrcadWindowsSecurity(root, output, 'win32-arm64')
  expect(readFileSync(join(output, 'windows-security.node'))).toEqual(readFileSync(arm64))
})

it('rejects a binary built for the wrong architecture', () => {
  const { root, output, write } = fixture()
  write('arm64', 0x8664)
  expect(() => stageOrcadWindowsSecurity(root, output, 'win32-arm64')).toThrow('machine 0x8664')
  expect(existsSync(join(output, 'windows-security.node'))).toBe(false)
})

it('fails the build off Windows when the addon was never built, and compiles it on Windows', () => {
  const { root, output, write } = fixture()
  expect(() => stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'linux' })).toThrow(
    'build-windows-security-addon.mjs --arch=x64'
  )

  const compile = vi.fn((compileRoot, arch) => write(arch, 0x8664))
  stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, compile)
  expect(compile).toHaveBeenCalledWith(root, 'x64', {})
  expect(existsSync(join(output, 'windows-security.node'))).toBe(true)
})

it('stages nothing for non-Windows slots', () => {
  const { root, output } = fixture()
  stageOrcadWindowsSecurity(root, output, 'linux-x64-glibc', { platform: 'linux' })
  stageOrcadWindowsSecurity(root, output, 'darwin-arm64', { platform: 'darwin' })
  expect(existsSync(join(output, 'windows-security.node'))).toBe(false)
})

it.each([
  ['older', false],
  ['current', true]
])('builds and collects security addons only when the %s source ships them', (_source, ships) => {
  const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
  const steps = [
    ...workflow.jobs.persistence.steps.filter((step) =>
      ['Build', 'Keep'].some((verb) => step.name?.startsWith(`${verb} the Windows security addons`))
    ),
    workflow.jobs.desktop_template.steps.find(
      (step) => step.name === 'Collect the Windows security addons'
    )
  ]
  expect(steps).toHaveLength(3)
  for (const step of steps) {
    const hashFiles = vi.fn((path) => {
      expect(path).toBe('config/scripts/build-windows-security-addon.mjs')
      return ships ? 'source-hash' : ''
    })
    expect(
      runInNewContext(step.if ?? 'true', {
        inputs: { build_template: true },
        matrix: { os: 'windows-2022' },
        hashFiles
      }),
      step.name
    ).toBe(ships)
    expect(hashFiles).toHaveBeenCalledOnce()
    expect(step['continue-on-error']).toBeUndefined()
  }
})

it('forwards the opt-in and pinned runtime only when compilation is needed', () => {
  const { root, output, write } = fixture()
  const options = { enabled: true, runtimePath: join(root, 'pinned node.exe') }
  const compile = vi.fn((_root, arch) => write(arch, 0x8664))
  stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, compile, options)
  expect(compile).toHaveBeenCalledWith(root, 'x64', options)
  compile.mockClear()
  stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, compile, options)
  expect(compile).not.toHaveBeenCalled()
})

it.each(['ssh-windows-hosts', 'node-server-tests'])(
  'opts in only after Windows preparation, retaining the SSH PR boundary in %s',
  (name) => {
    const workflow = parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
    const job = workflow.jobs[name === 'ssh-windows-hosts' ? 'hosts' : 'persistence']
    const preparation = job.steps.find((step) => step.id === 'dependencies')
    const build = job.steps.find((step) => step.env?.ORCA_REUSE_PREPARED_WINDOWS_SECURITY)
    expect(preparation.uses).toBe('./.github/actions/install-node-dependencies')
    expect(preparation.with['native-runtime']).toContain('node')
    expect(job.steps.indexOf(preparation)).toBeLessThan(job.steps.indexOf(build))
    expect(preparation['continue-on-error']).toBeUndefined()
    expect(build['continue-on-error']).toBeUndefined()
    expect(build.run).toContain(
      name === 'ssh-windows-hosts' ? 'build-orcad-template.mjs' : 'pnpm build:orcad'
    )
    for (const event of ['pull_request', 'push', 'workflow_dispatch', 'schedule']) {
      for (const outcome of ['success', 'failure', 'skipped', undefined]) {
        for (const os of ['Windows', 'Linux', 'macOS']) {
          const enabled = runInNewContext(
            build.env.ORCA_REUSE_PREPARED_WINDOWS_SECURITY.slice(3, -2),
            {
              github: { event_name: event },
              runner: { os },
              steps: { dependencies: { outcome } }
            }
          )
          expect(enabled).toBe(
            (name === 'node-server-tests' || event === 'pull_request') &&
              outcome === 'success' &&
              (name === 'ssh-windows-hosts' || os === 'Windows')
          )
        }
      }
    }
  }
)

it('opts the Windows E2E build into security reuse after Electron preparation', () => {
  const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
  const job = workflow.jobs['orcad-serve-mode-switch-windows']
  const preparation = job.steps.find(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  const build = job.steps.find(
    (step) => step.name === 'Build the e2e app, CLI, orcad slot and template'
  )
  expect(job['runs-on']).toBe('windows-2022')
  expect(preparation.with['native-runtime']).toBe('electron')
  expect(job.steps.indexOf(preparation)).toBeLessThan(job.steps.indexOf(build))
  expect(preparation['continue-on-error']).toBeUndefined()
  expect(build['continue-on-error']).toBeUndefined()
  expect(build.env.ORCA_REUSE_PREPARED_WINDOWS_SECURITY).toBe('true')
  expect(job.env.ORCA_REUSE_PREPARED_WINDOWS_SECURITY).toBeUndefined()
})

it.each([false, true])('passes an explicit CLI opt-in only when enabled: %s', (enabled) => {
  const { root, output, write } = fixture()
  const runtimePath = join(root, 'pinned node.exe')
  const run = vi.fn(() => {
    write('x64', 0x8664)
    return { code: 0 }
  })
  stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, undefined, {
    enabled,
    runtimePath,
    run
  })
  expect(run).toHaveBeenLastCalledWith({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-windows-security-addon.mjs'),
      '--arch=x64',
      ...(enabled ? ['--reuse-prepared-runtime', `--node-runtime=${runtimePath}`] : [])
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
})

it('does not stage an addon when the child builder fails', () => {
  const { root, output } = fixture()
  const run = vi.fn(() => ({ code: 1 }))
  expect(() =>
    stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, undefined, { run })
  ).toThrow('failed with exit 1')
  expect(existsSync(join(output, 'windows-security.node'))).toBe(false)
})
