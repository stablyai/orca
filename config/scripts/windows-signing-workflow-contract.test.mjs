import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
      'Restore signed uninstaller for the installer rebuild',
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

// Why these exist: the NSIS uninstaller is generated inside electron-builder's
// uninstaller pass and deleted immediately after being embedded, so the only way
// CI can sign it is the export/import relay through win.signtoolOptions.sign.
// Every link is asserted here the way Orca.exe and conpty_console_list.node are.
describe('Windows NSIS uninstaller signing', () => {
  const releaseSteps = () => readWorkflow('.github/workflows/release-cut.yml').jobs.build.steps
  const stepNamed = (steps, name) => steps.find((step) => step.name === name)

  const EXPORT_ENV = 'ORCA_WIN_UNINSTALLER_EXPORT_PATH'
  const SIGNED_ENV = 'ORCA_WIN_UNINSTALLER_SIGNED_PATH'

  it('exports the uninstaller from the first Windows build', () => {
    const build = stepNamed(releaseSteps(), 'Build Windows release artifacts')

    expect(build.env[EXPORT_ENV]).toContain('uninstaller-signing')
    expect(build.env[EXPORT_ENV]).toContain('orca-uninstaller.exe')
  })

  // Why this is a test and not a comment: `files` in the electron-builder config
  // is all-negation, so app-builder packs whatever is left in the checkout root.
  // These steps retry, and a retried attempt would pack an unsigned .exe into
  // app.asar — the very defect this chain removes. Every relay path must live
  // outside the checkout.
  it('keeps every relay path out of the packed checkout', () => {
    const relayEnvValues = [
      ...releaseSteps(),
      ...readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.rehearse.steps
    ].flatMap((step) => [step.env?.[EXPORT_ENV], step.env?.[SIGNED_ENV]].filter(Boolean))

    expect(relayEnvValues.length).toBe(4)
    for (const value of relayEnvValues) {
      expect(value).toContain('runner.temp')
      expect(value).not.toContain('github.workspace')
    }

    const relayScripts = [
      ...releaseSteps(),
      ...readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.rehearse.steps
    ]
      .map((step) => step.run ?? '')
      .filter((run) => run.includes('uninstaller-signing'))

    expect(relayScripts.length).toBeGreaterThan(0)
    for (const run of relayScripts) {
      // Why count occurrences rather than assert `toContain` once: a step
      // carrying two relay paths could root the first in RUNNER_TEMP and leave
      // the second bare-relative — which resolves against the checkout, and is
      // exactly the shape of the defect this test exists to catch.
      const mentions = run.match(/uninstaller-signing/g) ?? []
      const rooted = run.match(/Join-Path \$env:RUNNER_TEMP 'uninstaller-signing/g) ?? []

      expect(rooted.length, run).toBe(mentions.length)
      expect(run).not.toContain('$env:GITHUB_WORKSPACE')
    }
  })

  it('stages the uninstaller into the same request as the inner binaries', () => {
    const stage = stepNamed(releaseSteps(), 'Stage unsigned inner PE files for signing')

    expect(stage.run).toContain('uninstaller-signing\\unsigned\\orca-uninstaller.exe')
    expect(stage.run).toContain('uninstaller\\orca-uninstaller.exe')
    // No third SignPath request: exactly two submissions, as budgeted for the
    // 1h + 4h approval waits inside the 360-minute job cap.
    const submissions = releaseSteps().filter(
      (step) => step.uses === 'signpath/github-action-submit-signing-request@v2'
    )
    expect(submissions).toHaveLength(2)
  })

  // A staged-but-unreturned uninstaller must not fail the inner chain, or a
  // SignPath artifact-configuration gap would cost the inner-binary signatures.
  it('keeps the uninstaller out of the inner-binary copy-back list', () => {
    const stage = stepNamed(releaseSteps(), 'Stage unsigned inner PE files for signing')
    const restoreInner = stepNamed(
      releaseSteps(),
      'Restore signed inner binaries into unpacked app'
    )

    expect(stage.run).not.toMatch(/\$list\.Add\(['"]uninstaller/)
    expect(restoreInner.run).not.toContain('orca-uninstaller.exe')
  })

  // This step's outcome gates the upload of every inner binary, so a filesystem
  // error while staging the uninstaller must not escape — otherwise one
  // uninstaller-specific failure costs every inner-binary signature, which is
  // strictly worse than the behaviour before this chain existed.
  it('cannot let an uninstaller staging failure cost the inner-binary signatures', () => {
    const stage = stepNamed(releaseSteps(), 'Stage unsigned inner PE files for signing')
    const uninstallerBlock = stage.run.slice(stage.run.indexOf('$exportedUninstaller'))

    expect(stage.run).toMatch(/try \{[\s\S]*\$exportedUninstaller[\s\S]*\} catch \{/)
    expect(uninstallerBlock).toContain('::warning::Could not stage the NSIS uninstaller')
    expect(uninstallerBlock).not.toContain('throw')
    // Explicit, so the catch does not silently depend on GitHub's
    // $ErrorActionPreference='Stop' default for `shell: pwsh`.
    expect(uninstallerBlock).toContain('New-Item -ItemType Directory -Force -Path (Split-Path')
    expect(uninstallerBlock).toMatch(/New-Item[^\r\n]*-ErrorAction Stop/)
    expect(uninstallerBlock).toMatch(/Copy-Item[^\r\n]*-ErrorAction Stop/)
    // The upload it gates still keys off this step, so the catch is load-bearing.
    expect(stepNamed(releaseSteps(), 'Upload unsigned inner binaries for SignPath').if).toContain(
      "steps.stage-inner.outcome == 'success'"
    )
  })

  it('re-injects the signed uninstaller into the rebuilt installer', () => {
    const steps = releaseSteps()
    const restore = stepNamed(steps, 'Restore signed uninstaller for the installer rebuild')
    const rebuild = stepNamed(steps, 'Rebuild NSIS installer from signed unpacked app')
    const names = steps.map((step) => step.name)

    expect(restore.if).toContain('github.run_attempt == 1')
    expect(restore.if).toContain("steps.restore-signed-inner.outcome == 'success'")
    expect(restore.run).toContain('orca-uninstaller.exe')
    expect(names.indexOf(restore.name)).toBeLessThan(names.indexOf(rebuild.name))
    expect(rebuild.env[SIGNED_ENV]).toContain('uninstaller-signing')
    // The rebuild must not depend on the uninstaller leg: a missing signed
    // uninstaller ships today's installer, it does not skip the rebuild.
    expect(rebuild.if).not.toContain('restore-signed-uninstaller')
  })

  // NSIS hides the uninstaller in a compressed data section the bundled 7za
  // cannot read, so the gate proves it from the sign hook's digest receipt
  // instead of extracting it — and only when the relay actually ran.
  it('reports the embedded uninstaller in the inner-binary evidence gate', () => {
    const gate = stepNamed(releaseSteps(), 'Verify Windows inner binary signatures')

    expect(gate.env.UNINSTALLER_SIGNING_COMPLETED).toBe(
      "${{ steps.restore-signed-uninstaller.outcome == 'success' }}"
    )
    expect(gate.run).toContain('.embedded-sha256')
    expect(gate.run).toContain("$env:UNINSTALLER_SIGNING_COMPLETED -eq 'true'")
    expect(gate.run).toContain('not signed by SignPath Foundation: Uninstall Orca.exe')
    // The uninstaller must not join the 7z payload loop, which cannot see it.
    expect(gate.run).not.toContain("$targets += 'Uninstall Orca.exe'")
  })

  it('rehearses the uninstaller leg end to end', () => {
    const steps = readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.rehearse
      .steps
    const names = steps.map((step) => step.name)
    const pack = stepNamed(steps, 'Package Windows app and export the NSIS uninstaller')
    const rebuild = stepNamed(steps, 'Build NSIS installer from signed unpacked app')
    const verify = stepNamed(steps, 'Verify signatures end to end')

    // --dir never produces an uninstaller, so the rehearsal has to build the
    // installer the way release-cut's first Windows pass does.
    expect(pack.run).toContain('--win --publish never')
    expect(pack.run).not.toContain('--dir')
    expect(pack.env[EXPORT_ENV]).toContain('orca-uninstaller.exe')
    expect(names).toContain('Restore signed uninstaller for the installer rebuild')
    expect(rebuild.env[SIGNED_ENV]).toContain('orca-uninstaller.exe')
    expect(verify.run).toContain('.embedded-sha256')
    // The receipt only proves the import leg ran. The rehearsal is where the
    // shipped uninstaller itself gets checked — the release job cannot install
    // onto the runner it publishes from.
    expect(verify.run).toContain('shipped: Uninstall Orca.exe')
    expect(verify.run).toContain('-tnsis')
    expect(verify.run).toContain("-ArgumentList '/S'")
  })

  // This workflow is the merge gate, so it must not be able to fail on its own
  // artefact: 7-Zip's NSIS handler is unreliable enough that its output has to
  // be corroborated before a signature verdict is drawn from it.
  it('never lets an unreliable extract fail the rehearsal', () => {
    const steps = readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.rehearse
      .steps
    const verify = stepNamed(steps, 'Verify signatures end to end')

    // The 7-Zip route is only trusted when it reproduces the relayed bytes;
    // otherwise it falls through to the install route rather than failing.
    expect(verify.run).toContain(
      'Write-Host "7-Zip\'s NSIS output did not match the relayed digest; falling back to a silent install."'
    )
    expect(verify.run).toMatch(/\$installedUninstaller = \$null\r?\n\s*\}/)

    // The comparison that is not tautological: a file NSIS wrote out, against
    // the digest the sign hook recorded.
    expect(verify.run).toContain('$shippedDigest -ne $expectedDigest')
    expect(verify.run).toContain('the uninstaller the installer ships is not the relayed one')

    // An installer that prompts must not hang to the 360-minute job cap, and
    // the app it launches must not outlive the step holding install-dir handles.
    expect(verify.run).toContain('-PassThru')
    expect(verify.run).toContain('$installerProcess.WaitForExit(300000)')
    expect(verify.run).toContain('the silent install did not exit within 5 minutes')
    expect(verify.run).toMatch(/for \(\$attempt = 0; \$attempt -lt 20; \$attempt\+\+\)/)
    expect(verify.run).toContain("Get-Process -Name 'orca-terminal-daemon'")
  })

  // resources\elevate.exe is downgraded to advisory because app-builder-lib's
  // CopyElevateHelper clobbers it on every nsis pack — a pre-existing defect
  // that predates the uninstaller relay and is being tracked separately. The
  // escape hatch it needed is the kind that quietly grows until the gate
  // asserts nothing, so pin it to exactly that one file.
  it('confines the advisory escape hatch to elevate.exe', () => {
    const steps = readWorkflow('.github/workflows/windows-signing-rehearsal.yml').jobs.rehearse
      .steps
    const verify = stepNamed(steps, 'Verify signatures end to end')
    const advisoryCalls = verify.run
      .split('\n')
      .filter((line) => line.includes('-Advisory') && line.includes('Test-Signature'))

    expect(advisoryCalls).toHaveLength(1)
    expect(advisoryCalls[0]).toContain('installed: $relative')
    expect(verify.run).toContain("if ($relative -eq 'resources\\elevate.exe')")

    // Both uninstaller verdicts stay fatal — the whole point of the gate.
    for (const call of ['relayed: orca-uninstaller.exe', 'shipped: Uninstall Orca.exe']) {
      const line = verify.run
        .split('\n')
        .find((it) => it.includes(`Test-Signature`) && it.includes(call))
      expect(line, call).toBeDefined()
      expect(line, call).not.toContain('-Advisory')
    }

    // An advisory must still reach the evidence artifact, or downgrading it
    // becomes indistinguishable from deleting the check.
    expect(verify.run).toContain('ADVISORY (known pre-existing')
    expect(verify.run).toContain('$script:advisories.Add($problem)')
  })

  it('wires the electron-builder sign hook that the relay depends on', () => {
    const require = createRequire(import.meta.url)
    const configPath = resolve(projectDir, 'config/electron-builder.config.cjs')
    delete require.cache[require.resolve(configPath)]
    const config = require(configPath)

    expect(typeof config.win.signtoolOptions.sign).toBe('function')
    delete require.cache[require.resolve(configPath)]
  })
})
