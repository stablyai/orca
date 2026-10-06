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
const provisioning = readFileSync(
  join(projectDir, 'config/ci/windows-ssh-provider/preview-ssh/prove-preview-openssh.ps1'),
  'utf8'
)
const capability = readFileSync(
  join(projectDir, 'config/ci/windows-ssh-provider/preview-ssh/windows-ssh-capability.ps1'),
  'utf8'
)
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
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job['timeout-minutes']).toBe(75)
    expect(runStep['timeout-minutes']).toBe(50)
  })

  it('overlaps only guarded ARM inbox capability preparation with the existing builds', () => {
    const selfTestIndex = job.steps.findIndex((step) => step.name?.startsWith('Self-test'))
    const prepareIndex = job.steps.findIndex((step) => step.id === 'inbox-capability')
    const installIndex = job.steps.findIndex(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const buildIndex = job.steps.findIndex((step) => step.name?.startsWith('Build this runner'))
    const prebuildIndex = job.steps.findIndex(
      (step) => step.uses === './.github/actions/prepare-orcad-prebuilds'
    )
    const templateIndex = job.steps.findIndex((step) => step.name?.startsWith('Build the win32'))
    const waitIndex = job.steps.findIndex((step) => step.wait === 'inbox-capability')
    const runIndex = job.steps.indexOf(runStep)
    expect([
      selfTestIndex,
      prepareIndex,
      installIndex,
      buildIndex,
      prebuildIndex,
      templateIndex,
      waitIndex,
      runIndex
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(job.steps[prepareIndex]).toMatchObject({
      background: true,
      shell: 'pwsh'
    })
    expect(job.steps[prepareIndex].if).toBeUndefined()
    expect(job.steps[waitIndex].if).toBeUndefined()
    expect(job.steps[prepareIndex].run.trim()).toMatch(
      /^if\('\$\{\{ matrix\.server }}' -eq 'inbox' -and '\$\{\{ matrix\.arch }}' -eq 'arm64'\)\{[\s\S]+\}$/
    )
    expect(job.steps[prepareIndex].run).toContain('Initialize-WindowsInboxSshCapability')
    expect(job.steps[prepareIndex].run).toContain('inbox-capability-preparation.json')
    expect(runStep.run).toContain('-InboxPreparationReceipt $preparation')
    expect(runStep.run).toContain(
      "$preparation=Join-Path $receipts 'inbox-capability-preparation.json'"
    )
    expect(runStep.run).toContain(
      "if('${{ matrix.server }}' -eq 'inbox' -and '${{ matrix.arch }}' -eq 'arm64'){$preparation="
    )
    expect(runStep.background).toBeUndefined()
    expect(job.steps.at(-1)).toMatchObject({ if: 'always()', uses: 'actions/upload-artifact@v7' })
  })

  it('shares one capability installer without bypassing native verification or private cleanup', () => {
    expect(capability.match(/Add-WindowsCapability -Online/g)).toHaveLength(1)
    expect(provisioning).not.toContain('Add-WindowsCapability')
    expect(provisioning).toContain(". (Join-Path $PSScriptRoot 'windows-ssh-capability.ps1')")
    expect(provisioning).toContain('Install-WindowsInboxSshCapability $Arch $report')
    const install = capability.slice(
      capability.indexOf('function Install-WindowsInboxSshCapability'),
      capability.indexOf('function Initialize-WindowsInboxSshCapability')
    )
    const mutation = install.indexOf('Add-WindowsCapability')
    expect(install.indexOf('Assert-IsolatedWindowsSshCi')).toBeLessThan(mutation)
    expect(install.indexOf('Assert-WindowsSshGlobalServerDormant')).toBeLessThan(mutation)
    expect(install.lastIndexOf('Assert-WindowsSshGlobalServerDormant')).toBeGreaterThan(mutation)
    expect(install.indexOf('Assert-WindowsSshStockShell')).toBeLessThan(mutation)
    expect(install.lastIndexOf('Assert-WindowsSshStockShell')).toBeGreaterThan(mutation)
    for (const check of [
      '(Machine $path) -ne $target.machine',
      'Get-AuthenticodeSignature -LiteralPath $path',
      'Inbox native input Microsoft signature invalid',
      "Write-Stage 'host-cell-probe-start'",
      "Write-Stage 'cleanup-default-shell-start'",
      "Write-Stage 'cleanup-service-stop-delete-start'"
    ]) {
      expect(provisioning).toContain(check)
    }
  })

  it('keeps preparation provenance separate from the oracle current capability state', () => {
    for (const [field, environment] of [
      ['sourceSha', 'GITHUB_SHA'],
      ['runId', 'GITHUB_RUN_ID'],
      ['runAttempt', 'GITHUB_RUN_ATTEMPT'],
      ['runnerName', 'RUNNER_NAME'],
      ['imageVersion', 'ImageVersion']
    ]) {
      expect(capability).toContain(`${field}=$env:${environment}`)
      expect(provisioning).toContain(`$preparation.${field} -ne $env:${environment}`)
    }
    expect(provisioning).toContain("$preparation.status -ne 'passed'")
    expect(provisioning).toContain('$preparation.arch -ne $Arch')
    expect(provisioning).toContain('$report.inboxCapabilityPreparation=$preparation')
    expect(capability).toContain('$Report.inboxCapabilityInitialState=[string]$capability.State')
    expect(capability).toContain("$report.status='failed';$report.error=$_.Exception.Message;throw")
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
