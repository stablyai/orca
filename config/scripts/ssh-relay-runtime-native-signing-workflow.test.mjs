import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const signingWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-native-signing.yml',
  import.meta.url
)
const buildWorkflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-artifacts.yml',
  import.meta.url
)
const releaseCutUrl = new URL('../../.github/workflows/release-cut.yml', import.meta.url)
const releaseMacUrl = new URL('../../.github/workflows/release-mac-build.yml', import.meta.url)

const EXPECTED_SECRETS = [
  'MAC_CERTS',
  'MAC_CERTS_PASSWORD',
  'SIGNPATH_API_TOKEN',
  'SLACK_WEBHOOK_URL'
]

function actionRefs(source) {
  return [...source.matchAll(/^\s*uses:\s+[^\s#]+@([^\s#]+)/gmu)].map((match) => match[1])
}

describe('SSH relay runtime native signing workflow', () => {
  it('is callable only and keeps credentialed jobs disconnected from release consumers', async () => {
    const [source, build, releaseCut, releaseMac] = await Promise.all([
      readFile(signingWorkflowUrl, 'utf8'),
      readFile(buildWorkflowUrl, 'utf8'),
      readFile(releaseCutUrl, 'utf8'),
      readFile(releaseMacUrl, 'utf8')
    ])
    const workflow = parse(source)

    expect(Object.keys(workflow.on)).toEqual(['workflow_call'])
    expect(workflow.on.workflow_call.inputs).toEqual({
      'source-sha': { required: true, type: 'string' }
    })
    expect(Object.keys(workflow.on.workflow_call.secrets)).toEqual(EXPECTED_SECRETS)
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['sign-macos-runtime', 'sign-windows-runtime'])
    expect(workflow.jobs['sign-macos-runtime']).toMatchObject({
      'timeout-minutes': 30,
      strategy: {
        'fail-fast': false,
        matrix: {
          include: [
            { runner: 'macos-15', tuple: 'darwin-arm64' },
            { runner: 'macos-15-intel', tuple: 'darwin-x64' }
          ]
        }
      }
    })
    expect(workflow.jobs['sign-windows-runtime']).toMatchObject({
      'timeout-minutes': 330,
      strategy: {
        'fail-fast': false,
        matrix: {
          include: [
            { runner: 'windows-11-arm', tuple: 'win32-arm64' },
            { runner: 'windows-2022', tuple: 'win32-x64' }
          ]
        }
      }
    })
    expect(actionRefs(source).every((ref) => /^[0-9a-f]{40}$/u.test(ref))).toBe(true)
    expect(source).not.toContain('continue-on-error')
    expect(source).not.toMatch(/\b(?:gh\s+release|softprops\/action-gh-release)\b/u)
    expect(source).toContain('orca-ssh-relay-runtime-v1-*.tar.br')
    expect(source).not.toContain('brew install xz')
    expect(source).not.toContain('command -v xz')
    expect(source.match(/ssh-relay-runtime-archive-extraction\.mjs/g)).toHaveLength(2)
    expect(source.match(/ssh-relay-runtime-native-signing-stage\.mjs/g)).toHaveLength(2)
    expect(source.match(/ssh-relay-runtime-native-signing-finalization\.mjs/g)).toHaveLength(2)
    expect(source).toContain('ssh-relay-runtime-macos-signing.mjs')
    expect(source).toContain(
      'signpath/github-action-submit-signing-request@b9d91eadd323de506c0c81cf0c7fe7438f3360fd'
    )
    for (const job of Object.values(workflow.jobs)) {
      const names = job.steps.map((step) => step.name)
      expect(names.indexOf('Reconstruct authenticated unsigned runtime')).toBeGreaterThan(
        names.indexOf('Download exact native build output')
      )
      expect(names.indexOf('Finalize verified signed runtime')).toBeGreaterThan(
        names.indexOf('Stage exact native signing payload')
      )
      expect(names.indexOf('Upload immutable signed runtime output')).toBeGreaterThan(
        names.indexOf('Finalize verified signed runtime')
      )
    }
    // Why: credentialed jobs stay inert until the separately gated release DAG is reviewed.
    for (const consumer of [build, releaseCut, releaseMac]) {
      expect(consumer).not.toContain('ssh-relay-runtime-native-signing.yml')
    }
  })
})
