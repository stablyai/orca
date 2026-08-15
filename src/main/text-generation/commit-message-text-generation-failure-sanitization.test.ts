import { describe, expect, it } from 'vitest'
import { generateCommitMessageFromContext } from './commit-message-text-generation'

describe('generateCommitMessageFromContext', () => {
  it('exposes raw CLI failure output only after path sanitization', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'You are generating a single git commit message for /secret/repo',
          stderr: 'raw failure output with /Users/thebr/My Repo/secret/file.ts',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: raw failure output with [path]'
    })
  })

  it('formats nonzero exit failures with extracted sanitized CLI details', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'ERROR: fatal: C:\\Users\\Brennan Doe\\secret\\file.ts failed',
          stderr: '',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: fatal: [path] failed'
    })
  })

  it('redacts UNC paths in CLI failure details', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'ERROR: failed at \\\\server\\share\\Brennan Repo\\secret\\file.ts',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: failed at [path]'
    })
  })

  it('reports an empty result with the stderr excerpt when exit 0 produces no stdout', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '\u001b[91m\u001b[1mError: \u001b[0mNo payment method',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty message. CLI output: Error: No payment method'
    })
  })

  it('surfaces pi auth failure detail end-to-end through the adjusted path sanitizer', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: [
            'No API key found for github-copilot.',
            '',
            'Use /login to log into a provider via OAuth or API key. See:',
            '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
            '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/models.md'
          ].join('\n'),
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'Pi CLI command failed with code 1: No API key found for github-copilot. Use /login to log into a provider via OAuth or API key. See: … [path]'
    })
  })

  it('preserves slash-commands while redacting multi-segment paths in failure detail', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'ERROR: run /login then check /Users/name/repo',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: run /login then check [path]'
    })
  })

  it('redacts a filesystem path embedded in a pi HTTP 401 payload', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"Invalid key loaded from /Users/name/.config/pi/auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"Invalid key loaded from [path]"}'
    })
  })

  it('redacts a Windows drive path with JSON-escaped backslashes in a payload', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"Invalid key loaded from C:\\\\Users\\\\name\\\\auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"Invalid key loaded from [path]"}'
    })
  })

  it('keeps a scheme:// remedy URL intact while still redacting paths', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr:
            '401: Visit https://console.anthropic.com/settings/keys then check /Users/name/.config/pi/auth.json',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'Pi CLI command failed with code 1: 401: Visit https://console.anthropic.com/settings/keys then check [path]'
    })
  })

  it('redacts key=/path shapes in provider bodies', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"rejected credential_path=/Users/name/.config/pi/auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"rejected credential_path=[path]"}'
    })
  })

  it.each([
    [
      'comma-prefixed list path',
      '401: {"message":"candidate list a,/Users/name/creds rejected"}',
      'Pi CLI command failed with code 1: 401: {"message":"candidate list a,[path] rejected"}'
    ],
    [
      'non-drive colon-prefixed path',
      '401: {"message":"slot 1:/Users/name/alt failed"}',
      'Pi CLI command failed with code 1: 401: {"message":"slot 1:[path] failed"}'
    ]
  ])('redacts a %s in provider bodies', async (_shape, stderr, expected) => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr,
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({ success: false, error: expected })
  })

  it('passes the live colonless 400 gateway payload through the sanitizer unmangled', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr:
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CcsZLJ5ZiLLNvpxcxDuU4"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result.success).toBe(false)
    if (result.success) {
      throw new Error('expected a failure result')
    }
    expect(result.error.startsWith('Pi CLI command failed with code 1: 400 {"type":"error"')).toBe(
      true
    )
    // The bare domain link survives path redaction so the remedy stays usable.
    expect(result.error).toContain('claude.ai/settings/usage')
    expect(result.error.length).toBeLessThanOrEqual(300)
  })
})
