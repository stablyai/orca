import { describe, expect, it } from 'vitest'
import {
  createSshDisposalError,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from '../ssh/ssh-channel-multiplexer'
import { generateCommitMessageFromContext } from './commit-message-text-generation'

describe('generateCommitMessageFromContext', () => {
  it('uses a prepared remote execution plan instead of running git on the remote side', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent --message {prompt}'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan, cwd, timeoutMs) => {
          expect(cwd).toBe('/repo')
          expect(timeoutMs).toBe(60_000)
          expect(plan.binary).toBe('agent')
          expect(plan.args).toHaveLength(2)
          expect(plan.args[0]).toBe('--message')
          expect(plan.args[1]).toContain('Staged files:\nM\tREADME.md')
          return {
            stdout: 'Add README note.\n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(result).toEqual({
      success: true,
      message: 'Add README note',
      agentLabel: 'agent'
    })
  })

  it('reports a remote transport timeout without claiming the agent is unreachable', async () => {
    const transportTimeout = Object.assign(
      new Error('Request "agent.execNonInteractive" timed out after 65000ms'),
      { code: SSH_MUX_REQUEST_TIMEOUT_CODE }
    )
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
        execute: async () => {
          throw transportTimeout
        }
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent took longer than 60s to respond and may still be running on the remote host.',
      canceled: undefined
    })
  })

  it('keeps the unverifiable wording when the link is declared lost instead of timing out', async () => {
    // Declaring a wedged link lost disposes the mux before the 30s response deadline, so this leg
    // now sees CONNECTION_LOST where it used to see SSH_MUX_REQUEST_TIMEOUT. Both mean the frame
    // reached the wire and no answer came back, so both must keep "may still be running" — falling
    // through to "could not be reached" asserts absence the client cannot observe
    // (docs/reference/ssh-execution-boundary.md).
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
        execute: async () => {
          throw createSshDisposalError('connection_lost')
        }
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent took longer than 60s to respond and may still be running on the remote host.',
      canceled: undefined
    })
  })

  it('sanitizes remote execution transport failures', async () => {
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
        execute: async () => {
          throw new Error('relay disconnected while reading /secret/repo')
        }
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'agent could not be reached on the remote PATH. Try again after the SSH connection recovers.'
    })
  })
})
