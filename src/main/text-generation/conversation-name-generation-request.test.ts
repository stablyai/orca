import {
  sourceShapedKimiOutput,
  realKimiOccupiedOutput
} from '../../shared/__fixtures__/kimi-generation-source-shaped'
import { describe, expect, it, vi } from 'vitest'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'
import { generateConversationNameFromContext } from './commit-message-text-generation'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { generateConversationName } from './conversation-name-generation-request'
import type { SpawnedSourceControlAgentProcess } from './source-control-text-generation-types'

describe('generateConversationName', () => {
  it('uses the shared remote plan with bounded template variables and a sanitized name', async () => {
    let prompt = ''
    let operation = ''
    const result = await generateConversationNameFromContext(
      { firstPrompt: `Fix login ${'x'.repeat(5000)}` },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        commandInputTemplate: 'Name this: {firstPrompt}'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan, cwd, timeoutMs, requestedOperation) => {
          expect(cwd).toBe('/repo')
          expect(timeoutMs).toBe(60_000)
          prompt = plan.stdinPayload ?? ''
          operation = requestedOperation
          return {
            stdout: '<think>draft</think>\n# Title: "Fix login flow"\nExtra line',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )
    expect(operation).toBe('conversation-name')
    expect(prompt).toHaveLength('Name this: '.length + 4000)
    expect(result).toEqual({ success: true, name: 'Fix login flow', agentLabel: 'agent' })
  })

  it('rejects empty output after sanitization', async () => {
    const result = await generateConversationNameFromContext(
      { firstPrompt: 'Fix login' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Title: ""',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )
    expect(result).toMatchObject({
      success: false,
      error: 'Generated chat name was empty after sanitization.'
    })
  })

  it.each(['cancel', 'occupied'])('handles a local %s outcome', async (outcome) => {
    const child = createMockDiscoveryChild()
    const spawnAgent = vi.fn(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test child implements every process member the generation lane reads.
      return child as unknown as SpawnedSourceControlAgentProcess
    })
    const pending = generateConversationName({
      context: { firstPrompt: 'Fix login' },
      params:
        outcome === 'cancel'
          ? { agentId: 'custom', model: '', customAgentCommand: 'agent' }
          : { agentId: 'kimi', model: 'default' },
      target: { kind: 'local', cwd: '/repo' },
      spawnAgent
    })
    expect(spawnAgent).toHaveBeenCalledOnce()
    if (outcome === 'occupied') {
      child.stdout.emit('data', Buffer.from(realKimiOccupiedOutput))
      child.emit('close', 4)
      expect(await pending).toMatchObject({
        success: false,
        error: expect.stringMatching(/Kimi.*active.*Stop.*exit.*try again/)
      })
      return
    }
    cancelLocalGeneration('conversation-name', '/repo')
    expect(await pending).toMatchObject({ success: false, canceled: true })
  })

  it.each(['custom', 'kimi'] as const)('%s local title', async (agentId) => {
    const child = createMockDiscoveryChild()
    const spawnAgent = vi.fn(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test child implements every process member the generation lane reads.
      return child as unknown as SpawnedSourceControlAgentProcess
    })
    const pending = generateConversationName({
      context: { firstPrompt: 'Fix login' },
      params: { agentId, model: agentId === 'kimi' ? 'default' : '', customAgentCommand: 'agent' },
      target: { kind: 'local', cwd: '/repo' },
      spawnAgent
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        agentId === 'kimi'
          ? sourceShapedKimiOutput('Title: "Fix login flow"')
          : 'Title: "Fix login flow"\n'
      )
    )
    child.emit('close', 0)
    expect(await pending).toEqual({
      success: true,
      name: 'Fix login flow',
      agentLabel: agentId === 'kimi' ? 'Kimi' : 'agent'
    })
  })
})
