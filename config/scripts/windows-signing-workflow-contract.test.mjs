import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

describe('Windows signing workflow contract', () => {
  it('preflights SignPath module install before Windows signing side effects', () => {
    const parsedWorkflow = readWorkflow('.github/workflows/release-windows-signing.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const installStepIndexes = stepNames.flatMap((name, index) =>
      name === 'Install SignPath PowerShell module' ? [index] : []
    )
    const buildIndex = stepNames.indexOf('Build Windows release artifacts')
    const verifyNodePtyIndex = stepNames.indexOf('Verify Windows node-pty ConPTY runtime')
    const uploadIndex = stepNames.indexOf('Upload unsigned inner binaries for SignPath')
    const downloadIndex = stepNames.indexOf('Download signed Windows installer from SignPath')

    expect(verifyNodePtyIndex).toBe(buildIndex + 1)
    expect(installStepIndexes).toHaveLength(1)
    expect(installStepIndexes[0]).toBeLessThan(buildIndex)
    expect(installStepIndexes[0]).toBeLessThan(uploadIndex)

    expect(steps[verifyNodePtyIndex].run).toContain(
      'dist/win-unpacked/resources/node_modules/node-pty/build/Release'
    )
    expect(steps[verifyNodePtyIndex].run).toContain('conpty/conpty.dll')

    const uploadThroughDownloadScript = steps
      .slice(uploadIndex, downloadIndex + 1)
      .map((step) => step.run ?? '')
      .join('\n')

    expect(uploadThroughDownloadScript).not.toContain('Install-Module -Name SignPath')

    const installStep = steps[installStepIndexes[0]]

    expect(installStep.if).toBe('github.run_attempt == 1')
    expect(installStep.uses).toBe('./.github/actions/install-signpath-module')
    expect(installStep.run).toBeUndefined()

    const installAction = readWorkflow('.github/actions/install-signpath-module/action.yml')
    const actionStep = installAction.runs.steps[0]
    const installRun = actionStep.run
    const sleepSeconds = [...installRun.matchAll(/Start-Sleep -Seconds (\d+)/g)].map(
      ([, seconds]) => seconds
    )

    expect(installAction.runs.using).toBe('composite')
    expect(actionStep.shell).toBe('pwsh')
    expect(installRun).toContain(
      'if ($null -eq (Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue))'
    )
    expect(installRun).toContain('Register-PSRepository -Default -InstallationPolicy Trusted')
    expect(installRun).toContain('Set-PSRepository -Name PSGallery -InstallationPolicy Trusted')
    expect(installRun).toMatch(/\$env:PSModulePath -split \[System\.IO\.Path\]::PathSeparator/)
    expect(installRun).toContain(
      "$signPathModulePath = Join-Path -Path $currentUserModuleRoot -ChildPath 'SignPath'"
    )
    expect(installRun).toMatch(/for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/)
    expect(sleepSeconds).toContain('15')
    expect(sleepSeconds).toContain('30')
    expect(installRun).toContain(
      'Install-Module -Name SignPath -Repository PSGallery -MinimumVersion 4.0.0 -MaximumVersion 4.999.999 -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop'
    )
    expect(installRun).toContain('Import-Module SignPath -ErrorAction Stop')
    expect(installRun).toContain(
      'Get-Command -Name Get-SignedArtifact -Module SignPath -ErrorAction Stop'
    )
    expect(installRun).toContain('Remove-Item -LiteralPath $signPathModulePath -Recurse -Force')
    expect(installRun).not.toContain('SignPath*')
    expect(installRun).not.toMatch(/throw\s+\$_/)
  })

  it('falls back to a hash-pinned SignPath nupkg when the gallery API is down', () => {
    const installAction = readWorkflow('.github/actions/install-signpath-module/action.yml')
    const installRun = installAction.runs.steps[0].run

    // Why: the gallery API 403s during Azure Front Door incidents while its CDN
    // stays up, so a pinned nupkg is the fallback. The hash pin is the only
    // integrity check on that route — losing it would let any payload install.
    const { 'fallback-version': version, 'fallback-sha256': sha256 } = installAction.inputs
    expect(version.default).toMatch(/^4\.\d+\.\d+$/)
    expect(sha256.default).toMatch(/^[0-9a-f]{64}$/)
    expect(installRun).toContain('Get-FileHash -LiteralPath $nupkg -Algorithm SHA256')
    expect(installRun).toContain('$actualHash -ne $expectedHash.ToUpperInvariant()')
    expect(installRun).toContain('throw "SHA-256 mismatch for $source')
    expect(installRun).toContain(
      'https://cdn.powershellgallery.com/packages/signpath.$version.nupkg'
    )

    // The module only resolves by name when the folder matches its ModuleVersion.
    expect(installRun).toContain(
      '$versionRoot = Join-Path -Path $signPathModulePath -ChildPath $version'
    )
    // The fallback only runs after the gallery route is exhausted, and still
    // fails the job when neither route produced a usable module.
    expect(installRun.indexOf('$installed = $true')).toBeLessThan(
      installRun.indexOf('if (-not $installed)')
    )
    expect(installRun).toContain('throw "Unable to install the SignPath PowerShell module')
  })

  it('still installs SignPath when the cut ref predates the composite action', () => {
    const parsedWorkflow = readWorkflow('.github/workflows/release-windows-signing.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const checkoutIndex = stepNames.indexOf('Checkout')
    const restoreIndex = stepNames.indexOf('Load signing control from the workflow commit')
    const installIndex = stepNames.indexOf('Install SignPath PowerShell module')

    // Why: the build job checks out the cut tag, which for a hotfix cut from an
    // older ref can predate `.github/actions/install-signpath-module`; without
    // this restore the `uses: ./…` step dies on a missing action.yml.
    expect(restoreIndex).toBeGreaterThan(checkoutIndex)
    expect(restoreIndex).toBeLessThan(installIndex)

    const restoreStep = steps[restoreIndex]
    const restoreRun = restoreStep.run

    expect(restoreStep.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}')
    expect(restoreRun).toContain('config/windows-signing')
    expect(restoreRun).toContain('git fetch --no-tags --depth=1 origin "$WORKFLOW_SHA"')
    expect(restoreRun).toContain('git checkout "$WORKFLOW_SHA" -- .github/actions')

    // Why: restoring the action must not turn signing into a soft dependency —
    // a missing module still has to fail the Windows job, and the CDN fallback
    // still has to reject an unexpected payload.
    expect(steps[installIndex]['continue-on-error']).toBeUndefined()
    expect(restoreStep['continue-on-error']).toBeUndefined()

    const installRun = readWorkflow('.github/actions/install-signpath-module/action.yml').runs
      .steps[0].run

    expect(installRun).toContain('$actualHash -ne $expectedHash.ToUpperInvariant()')
    expect(installRun).toContain('throw "SHA-256 mismatch for $source')
  })

  it('never recreates signing requests on reruns and resumes immutable checkpoints', () => {
    const { jobs } = readWorkflow('.github/workflows/release-windows-signing.yml')
    for (const name of ['build', 'package']) {
      const steps = jobs[name].steps
      const submissions = steps.filter((s) => s.uses?.startsWith('signpath/'))
      expect(submissions).toHaveLength(1)
      expect(submissions[0].if).toBe('github.run_attempt == 1')
      expect(submissions[0].with['wait-for-completion']).toBe(false)
      expect(
        steps.some(
          (s) => s.name.startsWith('Restore original') && s.if === 'github.run_attempt != 1'
        )
      ).toBe(true)
      expect(steps.find((s) => s.name.startsWith('Upload immutable')).with.name).toContain(
        '${{ github.run_id }}-1-'
      )
    }
  })

  it('uses the exact production stage graph for isolated nonpublishing rehearsal', () => {
    const rehearsal = readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.signing
    expect(rehearsal.uses).toBe('./.github/workflows/release-windows-signing.yml')
    expect(rehearsal.with.publish).toBe(false)
    expect(rehearsal.with.signing_policy).toBe('test-signing')
    expect(rehearsal.with.environment_prefix).toBe('windows-rehearsal')
  })

  it('waits before runner allocation and blocks publication on both signature gates', () => {
    const { jobs } = readWorkflow('.github/workflows/release-windows-signing.yml')
    expect(jobs.package.needs).toBe('build')
    expect(jobs.package.environment.name).toBe('${{ inputs.environment_prefix }}-inner-signing')
    expect(jobs.finalize.needs).toBe('package')
    expect(jobs.finalize.environment.name).toBe(
      '${{ inputs.environment_prefix }}-installer-signing'
    )
    for (const job of Object.values(jobs)) {
      expect(job['runs-on']).toBe('windows-2022')
      expect(job.steps[0].name).toBe('Validate signing mode')
      for (const step of job.steps.filter((s) => !s.name.startsWith('Notify Slack'))) {
        expect(step['continue-on-error'], step.name).toBeUndefined()
      }
    }
    const names = jobs.finalize.steps.map((s) => s.name)
    const publish = names.indexOf('Publish signed Windows release artifacts')
    for (const gate of [
      'Verify signed Windows installer',
      'Regenerate signed installer update metadata',
      'Verify Windows inner binary signatures'
    ]) {
      expect(names.indexOf(gate)).toBeGreaterThan(-1)
      expect(names.indexOf(gate)).toBeLessThan(publish)
    }
    expect(
      readWorkflow('.github/workflows/release-cut.yml').jobs['publish-release'].needs
    ).toContain('build-windows')
  })
})

// Why these exist: the NSIS uninstaller is generated inside electron-builder's
// uninstaller pass and deleted immediately after being embedded, so the only way
// CI can sign it is the export/import relay through win.signtoolOptions.sign.
// Every link is asserted here the way Orca.exe and conpty_console_list.node are.
describe('Windows NSIS uninstaller signing', () => {
  const workflow = readWorkflow('.github/workflows/release-windows-signing.yml')
  const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps)
  const step = (name) => allSteps.find((s) => s.name === name)
  const script = (name) => readFileSync(join(projectDir, `config/windows-signing/${name}`), 'utf8')

  it('exports outside the checkout and includes the uninstaller in the first request', () => {
    const build = step('Build Windows release artifacts')
    expect(build.env.ORCA_WIN_UNINSTALLER_EXPORT_PATH).toContain('${{ runner.temp }}')
    expect(build.with.command).toContain('electron-builder-signing.config.cjs')
    expect(script('stage-inner.ps1')).toContain('uninstaller/orca-uninstaller.exe')
    expect(script('stage-inner.ps1')).toContain(
      "throw 'The NSIS build did not export an uninstaller"
    )
    expect(allSteps.filter((s) => s.uses?.startsWith('signpath/'))).toHaveLength(2)
  })

  it('restores the signed uninstaller before rebuilding and rejects missing or invalid signatures', () => {
    const names = workflow.jobs.package.steps.map((s) => s.name)
    expect(names.indexOf('Restore signed uninstaller for the installer rebuild')).toBeLessThan(
      names.indexOf('Rebuild NSIS installer from signed unpacked app')
    )
    expect(script('restore-uninstaller.ps1')).toContain('Assert-SigningCertificate')
    expect(script('package-installer.ps1')).toContain('ORCA_WIN_UNINSTALLER_SIGNED_PATH')
    expect(script('package-installer.ps1')).toContain('Remove-Item -LiteralPath $receipt')
    expect(script('package-installer.ps1')).toContain('verify-uninstaller.ps1')
  })

  it('preserves the relay hook when the release tag predates it', () => {
    const wrapper = script('electron-builder-signing.config.cjs')
    expect(wrapper).toContain('config/electron-builder.config.cjs')
    expect(wrapper).toContain('sign: signWindowsUninstallerViaSignPath')
    for (const job of Object.values(workflow.jobs)) {
      const load = job.steps.find((s) => s.name === 'Load signing control from the workflow commit')
      expect(load.run).toContain(
        'git checkout "$WORKFLOW_SHA" -- config/scripts/windows-uninstaller-signing.cjs'
      )
    }
  })

  it('keeps certificate policies and versioned tool caches isolated', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps[0].run).toContain('ELECTRON_BUILDER_CACHE=$(Join-Path $env:RUNNER_TEMP')
      const cache = job.steps.find((s) => s.name === 'Cache electron-builder downloads')
      expect(cache.with.key).toContain('${{ inputs.signing_policy }}')
      expect(cache.with['restore-keys']).toContain('${{ inputs.signing_policy }}')
    }
    expect(script('replace-elevate.ps1')).toContain(
      'node config/scripts/replace-cached-nsis-elevate.mjs'
    )
    expect(script('replace-elevate.ps1')).toContain('Assert-SigningCertificate')
    expect(script('checkpoint.ps1')).toContain('$env:ELECTRON_BUILDER_CACHE')
    expect(script('checkpoint.ps1')).not.toContain("@('nsis', 'nsis-resources')")
  })

  it('checkpoints and verifies the signed bytes and fresh embedding receipt before publishing', () => {
    expect(script('checkpoint.ps1')).toContain('orca-uninstaller.exe.embedded-sha256')
    expect(script('verify-uninstaller.ps1')).toContain('Get-FileHash')
    expect(script('verify-uninstaller.ps1')).toContain('Assert-SigningCertificate')
    const names = workflow.jobs.finalize.steps.map((s) => s.name)
    expect(names.indexOf('Verify embedded uninstaller signature and receipt')).toBeLessThan(
      names.indexOf('Publish signed Windows release artifacts')
    )
    expect(step('Verify embedded uninstaller signature and receipt').if).toBeUndefined()
    expect(step('Upload Windows inner signing evidence').with.path).toContain(
      'uninstaller-signing-evidence.txt'
    )
  })

  it('retains the shipped-uninstaller rehearsal with bounded install fallback', () => {
    expect(step('Verify shipped uninstaller during rehearsal').if).toBe('!inputs.publish')
    const verify = script('verify-shipped-uninstaller.ps1')
    expect(verify).toContain('-tnsis')
    expect(verify).toContain('WaitForExit(300000)')
    expect(verify).toContain('-ArgumentList "/S /D=$installRoot"')
    expect(verify).toContain('$actual -cne $expectedDigest')
    expect(verify).toContain("'shipped: Uninstall Orca.exe'")
    expect(verify).not.toContain('-Advisory')
    expect(verify).toContain("Get-Process -Name 'orca-terminal-daemon'")
  })
})
