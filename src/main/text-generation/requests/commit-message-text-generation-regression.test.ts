import { describe, expect, it } from 'vitest'
import { generateCommitMessageFromContext } from '../commit-message-text-generation'

function runFailedGeneration(
  params: Parameters<typeof generateCommitMessageFromContext>[1],
  output: { stdout?: string; stderr: string }
) {
  return generateCommitMessageFromContext(
    { branch: 'main', stagedSummary: 'M src/policy.ts', stagedPatch: '+change' },
    params,
    {
      kind: 'remote',
      cwd: '/remote/repo',
      missingBinaryLocation: 'remote PATH',
      execute: async () => ({
        stdout: output.stdout ?? '',
        stderr: output.stderr,
        exitCode: 1,
        timedOut: false
      })
    }
  )
}

describe('commit-message generation regressions', () => {
  it('keeps bounded diagnostic captures out of commit-message results', async () => {
    const result = await runFailedGeneration(
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        stdout: 'prompt echoed from /Users/private/source/repo',
        stderr: 'failed reading /Users/private/source/repo/.env'
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'agent CLI command failed with code 1: failed reading [path]',
      canceled: undefined
    })
    expect(JSON.stringify(result)).not.toContain('/Users/private')
    expect(result).not.toHaveProperty('failureOutput')
  })

  it('redacts drive and UNC paths in stdout while preserving the slash command', async () => {
    const result = await runFailedGeneration(
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        stdout:
          'ERROR: run /login; drive="C:\\Users\\Example User\\secret\\file.ts"; share="\\\\server\\share\\Example Repo\\file.ts"',
        stderr: ''
      }
    )
    expect(result).toMatchObject({
      success: false,
      error:
        'agent CLI command failed with code 1: ERROR: run /login; drive="[path]"; share="[path]"'
    })
  })

  it('keeps a remedy URL and redacts path variants in a Pi provider payload', async () => {
    const result = await runFailedGeneration(
      { agentId: 'pi', model: 'github-copilot/gpt-5.5' },
      {
        stderr:
          '401: {"remedy":"https://x.test/help/keys","message":"Invalid key from /home/me/pi/auth.json","windows":"C:\\\\Users\\\\me\\\\auth.json","field":"credential_path=/home/me/creds","list":"candidate a,/home/me/creds","slot":"slot 1:/home/me/alt"}'
      }
    )
    expect(result).toMatchObject({
      success: false,
      error:
        'Pi CLI command failed with code 1: 401: {"remedy":"https://x.test/help/keys","message":"Invalid key from [path]","windows":"[path]","field":"credential_path=[path]","list":"candidate a,[path]","slot":"slot 1:[path]"}'
    })
  })
})
