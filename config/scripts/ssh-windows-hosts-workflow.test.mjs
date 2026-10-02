import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  WINDOWS_FORBIDDEN_TOOLS,
  WINDOWS_HOST_CELL_IDS
} from '../../src/main/ssh/ssh-windows-host-cells.ts'

const projectDir = resolve(import.meta.dirname, '../..')
const workflow = parse(
  readFileSync(join(projectDir, '.github/workflows/ssh-windows-hosts.yml'), 'utf8')
)
const job = workflow.jobs.hosts
const runStep = job.steps.find((step) => step.name?.startsWith('Run the Windows host cells'))
const manifest = (arch) =>
  JSON.parse(
    readFileSync(
      join(
        projectDir,
        `config/ci/windows-ssh-provider/preview-ssh/preview-native-inputs-${arch}.json`
      ),
      'utf8'
    )
  )

describe('SSH Windows-host workflow', () => {
  it('runs on demand and on path-filtered, non-draft pull requests only', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_dispatch'])
    const paths = workflow.on.pull_request.paths
    expect(paths).toContain('src/main/ssh/ssh-relay-*')
    expect(paths).toContain('config/ci/windows-ssh-provider/**')
    expect(paths.indexOf('src/main/ssh/ssh-relay-windows-host-lane.test.ts')).toBeGreaterThan(
      paths.indexOf('!src/**/*.test.ts')
    )
    expect(job.if).toContain('github.event.pull_request.draft != true')
  })

  it('covers inbox and preview OpenSSH on both Windows architectures', () => {
    const cells = job.strategy.matrix.include.map(({ arch, runner, server }) =>
      [arch, runner, server].join('/')
    )
    expect(cells.sort()).toEqual([
      'arm64/windows-11-arm/inbox',
      'arm64/windows-11-arm/preview',
      'x64/windows-2022/inbox',
      'x64/windows-2022/preview'
    ])
    expect(job.env).toMatchObject({ ORCA_BACKGROUND_LAUNCH: '1', ORCA_ISOLATED_SSH_CI: '1' })
  })

  it('fetches the preview release its hash manifests pin', () => {
    for (const arch of ['x64', 'arm64']) {
      expect(runStep.run).toContain(
        `https://github.com/PowerShell/Win32-OpenSSH/releases/download/${manifest(arch).release}/`
      )
    }
  })

  it('builds the template for this runner only and shims exactly the cell toolchain list', () => {
    const build = job.steps.map((step) => step.run ?? '').join('\n')
    expect(build).toContain('--targets "win32-${{ matrix.arch }}"')
    expect(build).toContain('pnpm run build:relay')
    const shimmed = /-HiddenTools @\(([^)]*)\)/.exec(runStep.run)?.[1]
    expect(shimmed?.split(',').map((tool) => tool.trim().replaceAll("'", ''))).toEqual([
      ...WINDOWS_FORBIDDEN_TOOLS
    ])
  })

  it('defaults to every cell the TypeScript lane knows', () => {
    const defaults = /\{\$cells=@\(([^)]*)\)\}/.exec(runStep.run)?.[1]
    expect(defaults?.split(',').map((id) => id.trim().replaceAll("'", ''))).toEqual([
      ...WINDOWS_HOST_CELL_IDS
    ])
    const invoker = readFileSync(
      join(projectDir, 'config/ci/windows-ssh-provider/invoke-pinned-relay-cells.ps1'),
      'utf8'
    )
    for (const id of WINDOWS_HOST_CELL_IDS) {
      expect(invoker).toContain(`'${id}'`)
    }
  })
})
