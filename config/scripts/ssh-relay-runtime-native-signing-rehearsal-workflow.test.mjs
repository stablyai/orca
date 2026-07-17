import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const rehearsalWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-native-signing-rehearsal.yml',
  import.meta.url
)
const buildWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-artifacts.yml',
  import.meta.url
)
const signingWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-native-signing.yml',
  import.meta.url
)
const releaseCutUrl = new URL('../../.github/workflows/release-cut.yml', import.meta.url)
const releaseMacUrl = new URL('../../.github/workflows/release-mac-build.yml', import.meta.url)

describe('SSH relay runtime native-signing rehearsal workflow', () => {
  it('requires an exact manual confirmation and keeps every production consumer disconnected', async () => {
    const [rehearsalSource, buildSource, signingSource, releaseCut, releaseMac] = await Promise.all(
      [
        readFile(rehearsalWorkflowUrl, 'utf8'),
        readFile(buildWorkflowUrl, 'utf8'),
        readFile(signingWorkflowUrl, 'utf8'),
        readFile(releaseCutUrl, 'utf8'),
        readFile(releaseMacUrl, 'utf8')
      ]
    )
    const rehearsal = parse(rehearsalSource)
    const build = parse(buildSource)
    const signing = parse(signingSource)

    expect(Object.keys(rehearsal.on)).toEqual(['workflow_dispatch'])
    expect(rehearsal.on.workflow_dispatch.inputs).toEqual({
      'expected-source-sha': {
        description: 'Exact 40-character source commit selected for this credentialed rehearsal',
        required: true,
        type: 'string'
      },
      confirmation: {
        description: 'Type SIGN SSH RELAY RUNTIME ARTIFACTS to authorize the rehearsal',
        required: true,
        type: 'string'
      }
    })
    expect(rehearsal.permissions).toEqual({ contents: 'read' })
    expect(rehearsal.concurrency).toEqual({
      group: 'ssh-relay-runtime-native-signing-rehearsal',
      'cancel-in-progress': false
    })
    expect(Object.keys(rehearsal.jobs)).toEqual([
      'authorize-rehearsal',
      'build-native-runtimes',
      'sign-native-runtimes'
    ])

    const authorization = rehearsal.jobs['authorize-rehearsal']
    expect(authorization['runs-on']).toBe('ubuntu-24.04')
    expect(authorization['timeout-minutes']).toBe(5)
    expect(authorization.steps.map((step) => step.name)).toEqual([
      'Bind confirmation to the selected exact source'
    ])
    expect(authorization.steps[0].env).toEqual({
      ORCA_RUNTIME_EXPECTED_SOURCE_SHA: '${{ inputs.expected-source-sha }}',
      ORCA_RUNTIME_CONFIRMATION: '${{ inputs.confirmation }}',
      ORCA_RUNTIME_SELECTED_SOURCE_SHA: '${{ github.sha }}'
    })
    expect(authorization.steps[0].run).toContain('SIGN SSH RELAY RUNTIME ARTIFACTS')
    expect(authorization.steps[0].run).toContain('^[0-9a-f]{40}$')
    expect(authorization.steps[0].run).toContain('ORCA_RUNTIME_SELECTED_SOURCE_SHA')

    expect(build.on.workflow_call.inputs).toEqual({
      'include-baseline-gates': {
        description: 'Run separately gated oldest-baseline qualification jobs',
        required: false,
        default: true,
        type: 'boolean'
      }
    })
    for (const jobName of [
      'verify-linux-runtime-baseline-userland',
      'verify-windows-runtime-baseline'
    ]) {
      expect(build.jobs[jobName].if).toBe(
        "github.event_name != 'workflow_call' || inputs.include-baseline-gates"
      )
    }

    expect(rehearsal.jobs['build-native-runtimes']).toEqual({
      needs: 'authorize-rehearsal',
      uses: './.github/workflows/ssh-relay-runtime-artifacts.yml',
      with: { 'include-baseline-gates': false }
    })
    expect(rehearsal.jobs['sign-native-runtimes']).toEqual({
      needs: 'build-native-runtimes',
      uses: './.github/workflows/ssh-relay-runtime-native-signing.yml',
      with: { 'source-sha': '${{ github.sha }}' },
      secrets: 'inherit'
    })

    expect(Object.keys(signing.on)).toEqual(['workflow_call'])
    expect(rehearsalSource).not.toMatch(/release|publish|upload-release-asset|contents:\s*write/u)
    for (const consumer of [releaseCut, releaseMac]) {
      expect(consumer).not.toContain('ssh-relay-runtime-native-signing-rehearsal.yml')
      expect(consumer).not.toContain('ssh-relay-runtime-native-signing.yml')
    }
  })
})
