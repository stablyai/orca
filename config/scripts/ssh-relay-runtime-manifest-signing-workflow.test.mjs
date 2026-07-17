import { access, readFile } from 'node:fs/promises'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-manifest-signing.yml',
  import.meta.url
)
const releaseCutUrl = new URL('../../.github/workflows/release-cut.yml', import.meta.url)
const releaseMacUrl = new URL('../../.github/workflows/release-mac-build.yml', import.meta.url)
const rehearsalUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-native-signing-rehearsal.yml',
  import.meta.url
)
const acceptedKeysUrl = new URL('../ssh-relay-runtime-manifest-accepted-keys.json', import.meta.url)

const EXPECTED_INPUTS = {
  'source-sha': { required: true, type: 'string' },
  'release-tag': { required: true, type: 'string' },
  'created-at': { required: true, type: 'string' },
  'relay-protocol-version': { required: true, type: 'number' }
}
const EXPECTED_ARTIFACTS = [
  'ssh-relay-runtime-linux-x64-glibc',
  'ssh-relay-runtime-linux-arm64-glibc',
  'ssh-relay-runtime-signed-darwin-x64',
  'ssh-relay-runtime-signed-darwin-arm64',
  'ssh-relay-runtime-signed-win32-x64',
  'ssh-relay-runtime-signed-win32-arm64'
]

function actionRefs(source) {
  return [...source.matchAll(/^\s*uses:\s+[^\s#]+@([^\s#]+)/gmu)].map((match) => match[1])
}

describe('SSH relay runtime protected manifest-signing workflow', () => {
  it('isolates the seed between credential-free reconstruction stages and stays disconnected', async () => {
    const [source, releaseCut, releaseMac, rehearsal] = await Promise.all([
      readFile(workflowUrl, 'utf8'),
      readFile(releaseCutUrl, 'utf8'),
      readFile(releaseMacUrl, 'utf8'),
      readFile(rehearsalUrl, 'utf8')
    ])
    const workflow = parse(source)

    expect(Object.keys(workflow.on)).toEqual(['workflow_call'])
    expect(workflow.on.workflow_call.inputs).toEqual(EXPECTED_INPUTS)
    expect(workflow.on.workflow_call.secrets).toEqual({
      SSH_RELAY_RUNTIME_MANIFEST_SEED: { required: true }
    })
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual([
      'prepare-manifest',
      'sign-manifest',
      'finalize-manifest'
    ])

    const prepare = workflow.jobs['prepare-manifest']
    const sign = workflow.jobs['sign-manifest']
    const finalize = workflow.jobs['finalize-manifest']
    expect(prepare).toMatchObject({ 'runs-on': 'ubuntu-24.04', 'timeout-minutes': 15 })
    expect(sign).toMatchObject({
      needs: 'prepare-manifest',
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 5,
      environment: 'relay-runtime-manifest-signing'
    })
    expect(finalize).toMatchObject({
      needs: ['prepare-manifest', 'sign-manifest'],
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 15
    })

    for (const artifact of EXPECTED_ARTIFACTS) {
      expect(source.match(new RegExp(`name: ${artifact}$`, 'gmu'))).toHaveLength(2)
      expect(JSON.stringify(sign)).not.toContain(artifact)
    }
    expect(source).not.toContain('pattern: ssh-relay-runtime-')
    expect(source).not.toContain('merge-multiple: true')
    expect(source.match(/ssh-relay-runtime-manifest-aggregate-command\.mjs prepare/g)).toHaveLength(
      1
    )
    expect(source.match(/ssh-relay-runtime-manifest-seed-signing\.mjs/g)).toHaveLength(1)
    expect(
      source.match(/ssh-relay-runtime-manifest-aggregate-command\.mjs finalize/g)
    ).toHaveLength(1)

    const seedReferences = source.match(/secrets\.SSH_RELAY_RUNTIME_MANIFEST_SEED/g) ?? []
    expect(seedReferences).toHaveLength(1)
    expect(JSON.stringify(sign)).toContain('secrets.SSH_RELAY_RUNTIME_MANIFEST_SEED')
    expect(JSON.stringify(prepare)).not.toContain('secrets.')
    expect(JSON.stringify(finalize)).not.toContain('secrets.')
    expect(actionRefs(source).every((ref) => /^[0-9a-f]{40}$/u.test(ref))).toBe(true)
    expect(source).not.toContain('continue-on-error')
    expect(source).not.toMatch(/contents:\s*write|gh\s+release|upload-release-asset/u)
    expect(source.match(/config\/ssh-relay-runtime-manifest-accepted-keys\.json/g)).toHaveLength(2)
    // Why: a placeholder key would make an unreviewed trust root look provisioned.
    await expect(access(acceptedKeysUrl)).rejects.toMatchObject({ code: 'ENOENT' })

    // Why: this capability must remain inert until release/publication and desktop gates are reviewed.
    for (const consumer of [releaseCut, releaseMac, rehearsal]) {
      expect(consumer).not.toContain('ssh-relay-runtime-manifest-signing.yml')
    }
  })
})
