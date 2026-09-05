import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

describe('Windows signing workflow contract', () => {
  it('preflights SignPath module install before Windows signing side effects', () => {
    const parsedWorkflow = readWorkflow('.github/workflows/release-cut.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const installStepIndexes = stepNames.flatMap((name, index) =>
      name === 'Install SignPath PowerShell module' ? [index] : []
    )
    const buildIndex = stepNames.indexOf('Build Windows release artifacts')
    const verifyNodePtyIndex = stepNames.indexOf('Verify Windows node-pty ConPTY runtime')
    const uploadIndex = stepNames.indexOf('Upload unsigned Windows installer for SignPath')
    const downloadIndex = stepNames.indexOf('Download signed Windows installer from SignPath')

    expect(verifyNodePtyIndex).toBe(buildIndex + 1)
    expect(installStepIndexes).toEqual([verifyNodePtyIndex + 1])
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

    expect(installStep.if).toBe("matrix.platform == 'win' && github.run_attempt == 1")
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
    const parsedWorkflow = readWorkflow('.github/workflows/release-cut.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const checkoutIndex = stepNames.indexOf('Checkout')
    const restoreIndex = stepNames.indexOf('Restore composite actions from the workflow ref')
    const installIndex = stepNames.indexOf('Install SignPath PowerShell module')

    // Why: the build job checks out the cut tag, which for a hotfix cut from an
    // older ref can predate `.github/actions/install-signpath-module`; without
    // this restore the `uses: ./…` step dies on a missing action.yml.
    expect(restoreIndex).toBeGreaterThan(checkoutIndex)
    expect(restoreIndex).toBeLessThan(installIndex)

    const restoreStep = steps[restoreIndex]
    const restoreRun = restoreStep.run

    expect(restoreStep.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}')
    expect(restoreRun).toContain('.github/actions/install-signpath-module/action.yml')
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

  it('never recreates Windows signing requests on a workflow rerun', () => {
    const parsedWorkflow = readWorkflow('.github/workflows/release-cut.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const skipStep = steps.find((step) => step.name === 'Skip Windows artifact rebuild on rerun')

    expect(skipStep?.if).toBe("matrix.platform == 'win' && github.run_attempt != 1")
    expect(skipStep?.run).toContain('Existing signed release assets must be reused')

    const signingStepNames = [
      'Build Windows release artifacts',
      'Stage unsigned inner PE files for signing',
      'Upload unsigned inner binaries for SignPath',
      'Submit inner binaries signing request',
      'Download signed inner binaries from SignPath',
      'Upload unsigned Windows installer for SignPath',
      'Submit Windows installer signing request',
      'Download signed Windows installer from SignPath',
      'Stage signed Windows release assets',
      'Publish signed Windows release artifacts'
    ]

    for (const stepName of signingStepNames) {
      const step = steps[stepNames.indexOf(stepName)]
      expect(step?.if, stepName).toContain('github.run_attempt == 1')
    }
  })

  it('shares one SignPath module install path between release and rehearsal', () => {
    const rehearsalWorkflow = readWorkflow('.github/workflows/windows-signing-rehearsal.yml')
    const stepNames = rehearsalWorkflow.jobs.rehearse.steps.map((step) => step.name)
    const installIndex = stepNames.indexOf('Install SignPath PowerShell module')

    // Why: the rehearsal exists to prove the real signing flow, so it must
    // install the module exactly the way the release job does.
    expect(rehearsalWorkflow.jobs.rehearse.steps[installIndex].uses).toBe(
      './.github/actions/install-signpath-module'
    )
    expect(rehearsalWorkflow.jobs.rehearse.steps[installIndex].run).toBeUndefined()
    expect(installIndex).toBeLessThan(
      stepNames.indexOf('Download signed inner binaries from SignPath')
    )
  })

  it('verifies Windows inner binary signatures fail-open before publishing', () => {
    const parsedWorkflow = readWorkflow('.github/workflows/release-cut.yml')
    const steps = parsedWorkflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const outerVerifyIndex = stepNames.indexOf('Verify signed Windows installer')
    const innerVerifyIndex = stepNames.indexOf('Verify Windows inner binary signatures')
    const evidenceIndex = stepNames.indexOf('Upload Windows inner signing evidence')
    const publishIndex = stepNames.indexOf('Publish signed Windows release artifacts')

    expect(outerVerifyIndex).toBeGreaterThan(-1)
    expect(innerVerifyIndex).toBe(outerVerifyIndex + 1)
    expect(evidenceIndex).toBe(innerVerifyIndex + 1)
    expect(publishIndex).toBe(evidenceIndex + 1)

    // Why fail-open: unsigned inner binaries must warn, not block, until the
    // flow is proven on a real release (issue #7785). Flip this to 'true'
    // together with the workflow env to make the gate required.
    expect(steps[innerVerifyIndex].env.ORCA_WINDOWS_INNER_SIGNATURE_REQUIRED).toBe('false')

    // Why: every step in the inner-signing chain must be unable to fail the
    // release — a SignPath outage or timeout falls through to today's
    // unsigned-inner flow instead of blocking the cut.
    const innerChainStepNames = [
      'Stage unsigned inner PE files for signing',
      'Upload unsigned inner binaries for SignPath',
      'Submit inner binaries signing request',
      'Notify Slack that inner-binary signing is waiting for approval',
      'Download signed inner binaries from SignPath',
      'Restore signed inner binaries into unpacked app',
      'Replace cached elevate.exe with the signed copy',
      'Rebuild NSIS installer from signed unpacked app'
    ]
    for (const stepName of innerChainStepNames) {
      const step = steps[stepNames.indexOf(stepName)]
      expect(step, stepName).toBeDefined()
      expect(step['continue-on-error'], stepName).toBe(true)
    }
  })
})
