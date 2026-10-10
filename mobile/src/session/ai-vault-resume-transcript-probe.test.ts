import { describe, expect, it, vi } from 'vitest'
import {
  probeMobileAiVaultTranscriptOnSshHost,
  selectMobileAiVaultTranscriptProbeCandidate
} from './ai-vault-resume-transcript-probe'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\s.jsonl'
const CAPS = ['aiVault.v1', 'aiVault.host-scope.v1']

function sender(response: unknown): { client: RpcOperationSender; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => response)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe only calls sendRequest.
  return { client: { sendRequest: send } as unknown as RpcOperationSender, send }
}

describe('probeMobileAiVaultTranscriptOnSshHost', () => {
  it('reports present and missing from the host answer', async () => {
    for (const status of ['present', 'missing'] as const) {
      const { client, send } = sender({ id: '1', ok: true, result: { status } })
      await expect(
        probeMobileAiVaultTranscriptOnSshHost({
          client,
          session: { filePath: WSL_PATH },
          targetHostId: 'ssh:builder',
          hostCapabilities: CAPS
        })
      ).resolves.toBe(status)
      expect(send).toHaveBeenCalledWith(
        'aiVault.probeSessionTranscript',
        { executionHostId: 'ssh:builder', filePath: WSL_PATH },
        expect.anything()
      )
    }
  })

  it('never calls a host that does not advertise the capability', async () => {
    const { client, send } = sender({ id: '1', ok: true, result: { status: 'missing' } })
    await expect(
      probeMobileAiVaultTranscriptOnSshHost({
        client,
        session: { filePath: WSL_PATH },
        targetHostId: 'ssh:builder',
        hostCapabilities: ['aiVault.v1']
      })
    ).resolves.toBe('unverifiable')
    expect(send).not.toHaveBeenCalled()
  })

  it('treats a refusal, a thrown error and a malformed reply as unverifiable', async () => {
    const refused = sender({
      id: '1',
      ok: false,
      error: { code: 'method_not_found', message: 'nope' }
    })
    const malformed = sender({ id: '1', ok: true, result: { status: 'weird' } })
    const thrown = { client: { sendRequest: vi.fn().mockRejectedValue(new Error('x')) } }
    for (const client of [
      refused.client,
      malformed.client,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe only calls sendRequest.
      thrown.client as unknown as RpcOperationSender
    ]) {
      await expect(
        probeMobileAiVaultTranscriptOnSshHost({
          client,
          session: { filePath: WSL_PATH },
          targetHostId: 'ssh:builder',
          hostCapabilities: CAPS
        })
      ).resolves.toBe('unverifiable')
    }
  })
})

describe('selectMobileAiVaultTranscriptProbeCandidate', () => {
  const candidates = [
    { id: 'a', transcriptProbeHostId: 'ssh:a' as const },
    { id: 'b', transcriptProbeHostId: 'ssh:b' as const },
    { id: 'c', transcriptProbeHostId: 'ssh:c' as const }
  ]

  function select(answers: Record<string, unknown>, list = candidates) {
    const send = vi.fn(async (_method: string, params: { executionHostId: string }) => {
      const answer = answers[params.executionHostId]
      if (answer instanceof Error) {
        throw answer
      }
      return { id: '1', ok: true, result: { status: answer } }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe only calls sendRequest.
    const client = { sendRequest: send } as unknown as RpcOperationSender
    const assertCurrentOwner = vi.fn()
    return {
      send,
      assertCurrentOwner,
      result: selectMobileAiVaultTranscriptProbeCandidate({
        client,
        session: { filePath: WSL_PATH },
        candidates: list,
        hostCapabilities: CAPS,
        assertCurrentOwner
      })
    }
  }

  it('resumes into the third host when only it has the transcript', async () => {
    const run = select({ 'ssh:a': 'missing', 'ssh:b': 'missing', 'ssh:c': 'present' })
    await expect(run.result).resolves.toEqual({ kind: 'resume', candidate: candidates[2] })
    expect(run.send).toHaveBeenCalledTimes(3)
    expect(run.assertCurrentOwner).toHaveBeenCalledTimes(3)
  })

  it('stops probing at the first present host', async () => {
    const run = select({ 'ssh:a': 'present', 'ssh:b': 'present', 'ssh:c': 'present' })
    await expect(run.result).resolves.toEqual({ kind: 'resume', candidate: candidates[0] })
    expect(run.send).toHaveBeenCalledTimes(1)
  })

  it('blocks only when every candidate is verified missing', async () => {
    const run = select({ 'ssh:a': 'missing', 'ssh:b': 'missing', 'ssh:c': 'missing' })
    await expect(run.result).resolves.toEqual({ kind: 'missing' })
  })

  it('proceeds with the first unverifiable candidate when none is present', async () => {
    const run = select({
      'ssh:a': new Error('link dropped'),
      'ssh:b': 'missing',
      'ssh:c': new Error('old host')
    })
    await expect(run.result).resolves.toEqual({ kind: 'resume', candidate: candidates[0] })
  })

  it('prefers a later present host over an earlier unverifiable one', async () => {
    const run = select({ 'ssh:a': new Error('x'), 'ssh:b': 'missing', 'ssh:c': 'present' })
    await expect(run.result).resolves.toEqual({ kind: 'resume', candidate: candidates[2] })
  })

  it('probes a single candidate once, as before', async () => {
    const run = select({ 'ssh:a': 'missing' }, [candidates[0]])
    await expect(run.result).resolves.toEqual({ kind: 'missing' })
    expect(run.send).toHaveBeenCalledTimes(1)
  })
})
