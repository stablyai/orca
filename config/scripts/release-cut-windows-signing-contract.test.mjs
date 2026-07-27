import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const workflowPath = join(projectDir, '.github/workflows/release-cut.yml')
const macWorkflowPath = join(projectDir, '.github/workflows/release-mac-build.yml')
const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

describe('release-cut Windows signing contract', () => {
  it('keeps release policy on canonical main and publishes only after rebuild', () => {
    const workflowText = readFileSync(workflowPath, 'utf8')
    const workflow = parse(workflowText)
    const cutJob = workflow.jobs.cut
    const controlPlaneStep = cutJob.steps[0]
    const versionStep = cutJob.steps.find((step) => step.name === 'Compute next version')
    const createReleaseJob = workflow.jobs['create-release']
    const createDraftStep = createReleaseJob.steps.find(
      (step) => step.name === 'Create draft release with bounded generated notes'
    )
    const macAuthorizationStep = createReleaseJob.steps.find(
      (step) => step.name === 'Upload macOS build authorization'
    )
    const buildJob = workflow.jobs.build
    const publishReleaseJob = workflow.jobs['publish-release']
    const createCheckout = createReleaseJob.steps.find((step) => step.name === 'Checkout')
    const buildCheckout = buildJob.steps.find((step) => step.name === 'Checkout')
    const publishCheckout = publishReleaseJob.steps.find((step) => step.name === 'Checkout')

    expect(cutJob.if).toBeUndefined()
    expect(controlPlaneStep.name).toBe('Validate release control plane')
    expect(controlPlaneStep.env.REPOSITORY).toBe('${{ github.repository }}')
    expect(controlPlaneStep.env.WORKFLOW_REF).toBe('${{ github.ref }}')
    expect(controlPlaneStep.run).toContain("WORKFLOW_REF\" != 'refs/heads/main'")
    expect(cutJob.outputs.tag).toContain('steps.version.outputs.recovered_tag')
    expect(cutJob.outputs.should_release).toContain('steps.version.outputs.recovered_tag')
    expect(cutJob.outputs.latest_published_rc_tag).toBeUndefined()
    expect(cutJob.steps.some((step) => step.id === 'publish_drafts')).toBe(false)
    expect(versionStep.if).not.toContain('publish_drafts')
    expect(workflow.jobs['homebrew-bump-published-rc-draft']).toBeUndefined()
    expect(workflowText).not.toContain('publish-complete-draft-releases')
    expect(existsSync(join(projectDir, 'config/scripts/publish-complete-draft-releases.mjs'))).toBe(
      false
    )
    expect(
      existsSync(join(projectDir, 'config/scripts/publish-complete-draft-releases.test.mjs'))
    ).toBe(false)

    expect(createReleaseJob.if).toBe("needs.cut.outputs.should_release == 'true'")
    expect(macAuthorizationStep.with.name).toBe(
      'release-mac-build-control-${{ github.run_id }}-${{ needs.cut.outputs.tag }}'
    )
    expect(macAuthorizationStep.with['if-no-files-found']).toBe('error')
    expect(buildJob.if).toBe("needs.cut.outputs.should_release == 'true'")
    expect(createCheckout.with.ref).toBe('${{ github.sha }}')
    expect(createDraftStep.run).toContain('Release $TAG is already public; refusing')
    expect(buildCheckout.with.ref).toBe('refs/tags/${{ needs.cut.outputs.tag }}')
    expect(publishReleaseJob.needs).toContain('build')
    expect(publishCheckout.with.ref).toBe('${{ github.sha }}')
    expect(workflowText.match(/--draft=false/g)).toHaveLength(1)
  })

  it('records the complete inner-signing chain before a release-blocking failure', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'))
    const steps = workflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const outerVerifyIndex = stepNames.indexOf('Verify signed Windows installer')
    const innerVerifyIndex = stepNames.indexOf('Verify Windows inner binary signatures')
    const evidenceIndex = stepNames.indexOf('Upload Windows inner signing evidence')
    const draftCheckIndex = stepNames.indexOf(
      'Verify release is draft before Windows artifact upload'
    )
    const publishIndex = stepNames.indexOf('Publish signed Windows release artifacts')
    const innerVerifyStep = steps[innerVerifyIndex]
    const evidenceStep = steps[evidenceIndex]
    const publishStep = steps[publishIndex]

    expect(outerVerifyIndex).toBeGreaterThan(-1)
    expect(innerVerifyIndex).toBe(outerVerifyIndex + 1)
    expect(evidenceIndex).toBe(innerVerifyIndex + 1)
    expect(draftCheckIndex).toBe(evidenceIndex + 1)
    expect(publishIndex).toBe(draftCheckIndex + 1)
    expect(innerVerifyStep.env.ORCA_WINDOWS_INNER_SIGNATURE_REQUIRED).toBe('true')
    expect(innerVerifyStep['continue-on-error']).toBeUndefined()
    expect(innerVerifyStep.if).toBe("always() && matrix.platform == 'win'")
    expect(evidenceStep.if).toBe("always() && matrix.platform == 'win'")
    expect(evidenceStep.with['if-no-files-found']).toBe('error')
    expect(publishStep.if).toBe("success() && matrix.platform == 'win'")

    const expectedOutcomes = {
      STAGE_INNER_OUTCOME: '${{ steps.stage-inner.outcome }}',
      UPLOAD_UNSIGNED_INNER_OUTCOME: '${{ steps.upload-unsigned-inner.outcome }}',
      SUBMIT_INNER_SIGNING_OUTCOME: '${{ steps.submit-inner-signing.outcome }}',
      NOTIFY_INNER_SIGNING_OUTCOME: '${{ steps.notify-inner-signing.outcome }}',
      DOWNLOAD_SIGNED_INNER_OUTCOME: '${{ steps.download-signed-inner.outcome }}',
      RESTORE_SIGNED_INNER_OUTCOME: '${{ steps.restore-signed-inner.outcome }}',
      SIGN_ELEVATE_CACHE_OUTCOME: '${{ steps.sign-elevate-cache.outcome }}',
      REBUILD_NSIS_SIGNED_OUTCOME: '${{ steps.rebuild-nsis-signed.outcome }}'
    }
    for (const [name, expression] of Object.entries(expectedOutcomes)) {
      expect(innerVerifyStep.env[name], name).toBe(expression)
    }

    const chainStepNames = [
      'Stage unsigned inner PE files for signing',
      'Upload unsigned inner binaries for SignPath',
      'Submit inner binaries signing request',
      'Notify Slack that inner-binary signing is waiting for approval',
      'Download signed inner binaries from SignPath',
      'Restore signed inner binaries into unpacked app',
      'Replace cached elevate.exe with the signed copy',
      'Rebuild NSIS installer from signed unpacked app'
    ]
    for (const stepName of chainStepNames) {
      const step = steps[stepNames.indexOf(stepName)]
      expect(step, stepName).toBeDefined()
      expect(step['continue-on-error'], stepName).toBe(true)
    }

    const evidenceRun = innerVerifyStep.run
    const firstEvidenceWrite = evidenceRun.indexOf("Set-Content -Path 'inner-signing-evidence.txt'")
    const incompleteChainCheck = evidenceRun.indexOf("if ($env:INNER_SIGNING_COMPLETED -ne 'true')")
    const verificationFailure = evidenceRun.indexOf('$report.Add("failure: $_")')
    const verificationThrow = evidenceRun.lastIndexOf('if ($required) { throw $message }')
    const caughtError = evidenceRun.indexOf('$report.Add("error: $($_.Exception.Message)")')
    const caughtErrorThrow = evidenceRun.indexOf('if ($required) { throw }')

    expect(innerVerifyStep.env.RELEASE_TAG).toBe('${{ needs.cut.outputs.tag }}')
    expect(firstEvidenceWrite).toBeGreaterThan(-1)
    expect(firstEvidenceWrite).toBeLessThan(incompleteChainCheck)
    expect(verificationFailure).toBeLessThan(verificationThrow)
    expect(caughtError).toBeLessThan(caughtErrorThrow)
  })

  it('keeps macOS publishing draft-only and coupled to an active release cut', () => {
    const workflow = parse(readFileSync(macWorkflowPath, 'utf8'))
    const preflightJob = workflow.jobs['validate-release-control-plane']
    const buildJob = workflow.jobs['build-mac']
    const controlPlaneStep = preflightJob.steps[0]
    const publishStep = buildJob.steps.find(
      (step) => step.name === 'Publish release artifacts (macOS)'
    )
    const preuploadStep = buildJob.steps.find(
      (step) => step.name === 'Verify release is draft before macOS artifact upload'
    )

    expect(workflow.permissions.actions).toBe('read')
    expect(workflow.permissions.contents).toBe('read')
    expect(preflightJob['runs-on']).toBe('ubuntu-latest')
    expect(buildJob.needs).toBe('validate-release-control-plane')
    expect(buildJob.permissions.contents).toBe('write')
    expect(buildJob.if).toBeUndefined()
    expect(controlPlaneStep.name).toBe('Validate release control plane and draft')
    expect(controlPlaneStep.run).toContain("WORKFLOW_REF\" != 'refs/heads/main'")
    expect(controlPlaneStep.run).toContain("run_path\" != '.github/workflows/release-cut.yml'")
    expect(controlPlaneStep.run).toContain("run_status\" != 'in_progress'")
    expect(controlPlaneStep.run).toContain(
      'authorization_name="release-mac-build-control-${RELEASE_RUN_ID}-${TAG}"'
    )
    expect(controlPlaneStep.run).toContain('.artifacts[]?')
    expect(controlPlaneStep.run).toContain("draft\" != 'true'")
    expect(buildJob.steps.indexOf(preuploadStep)).toBe(buildJob.steps.indexOf(publishStep) - 1)
    expect(publishStep.with.command).toContain('--publish always')
    expect(publishStep.env.EP_DRAFT).toBe('true')
    expect(electronBuilderConfig.publish.releaseType).toBe('draft')
  })

  it('pins draft policy in protected workflow steps for historical source tags', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'))
    const steps = workflow.jobs.build.steps
    const stepNames = steps.map((step) => step.name)
    const linuxPreuploadIndex = stepNames.indexOf(
      'Verify release is draft before Linux artifact upload'
    )
    const linuxPublishIndex = stepNames.indexOf('Publish release artifacts (Linux)')
    const linuxPublishStep = steps[linuxPublishIndex]

    expect(linuxPreuploadIndex).toBe(linuxPublishIndex - 1)
    expect(linuxPublishStep.env.EP_DRAFT).toBe('true')
    expect(workflow.jobs.build.steps.find((step) => step.name === 'Checkout').with.ref).toBe(
      'refs/tags/${{ needs.cut.outputs.tag }}'
    )
  })
})
