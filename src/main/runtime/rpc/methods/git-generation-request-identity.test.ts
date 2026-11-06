import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { GIT_COMMIT_MESSAGE_GENERATION_METHODS } from './git-commit-message-generation-methods'

function makeRequest(method: string, params: unknown): RpcRequest {
  return { id: 'rpc-request', authToken: 'token', method, params }
}

function harness() {
  const generateCommit = vi.fn().mockResolvedValue({ success: true, message: 'Commit' })
  const stopCommit = vi.fn().mockResolvedValue({ ok: true })
  const generateReview = vi.fn().mockResolvedValue({ success: true, fields: {} })
  const stopReview = vi.fn().mockResolvedValue({ ok: true })
  const stub = {
    getRuntimeId: () => 'test-runtime',
    generateRuntimeCommitMessage: generateCommit,
    cancelRuntimeGenerateCommitMessage: stopCommit,
    generateRuntimePullRequestFields: generateReview,
    cancelRuntimeGeneratePullRequestFields: stopReview
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this explicit method registry only calls the supplied runtime operations.
  const runtime = stub as unknown as OrcaRuntimeService
  return {
    dispatcher: new RpcDispatcher({ runtime, methods: GIT_COMMIT_MESSAGE_GENERATION_METHODS }),
    generateCommit,
    stopCommit,
    generateReview,
    stopReview
  }
}

describe.each([
  {
    generate: 'git.generateCommitMessage',
    stop: 'git.cancelGenerateCommitMessage',
    input: { worktree: 'id:wt-1' },
    generationArgs: ['id:wt-1', undefined],
    chooseGenerate: (test: ReturnType<typeof harness>) => test.generateCommit,
    chooseStop: (test: ReturnType<typeof harness>) => test.stopCommit
  },
  {
    generate: 'git.generatePullRequestFields',
    stop: 'git.cancelGeneratePullRequestFields',
    input: { worktree: 'id:wt-1', base: 'main', title: '', body: '', draft: false },
    generationArgs: [
      'id:wt-1',
      {
        base: 'main',
        title: '',
        body: '',
        draft: false,
        provider: undefined,
        useTemplate: undefined
      },
      undefined
    ],
    chooseGenerate: (test: ReturnType<typeof harness>) => test.generateReview,
    chooseStop: (test: ReturnType<typeof harness>) => test.stopReview
  }
])(
  '$generate identity',
  ({ generate, stop, input, generationArgs, chooseGenerate, chooseStop }) => {
    it.each(['', 'x'.repeat(129)])(
      'rejects malformed ID %j before either runtime branch',
      async (generationId) => {
        const test = harness()
        await expect(
          test.dispatcher.dispatch(makeRequest(generate, { ...input, generationId }))
        ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
        await expect(
          test.dispatcher.dispatch(makeRequest(stop, { worktree: 'id:wt-1', generationId }))
        ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
        expect(chooseGenerate(test)).not.toHaveBeenCalled()
        expect(chooseStop(test)).not.toHaveBeenCalled()
      }
    )

    it('uses the authenticated device across different Generate and Stop sockets', async () => {
      const test = harness()
      await expect(
        test.dispatcher.dispatch(
          makeRequest(generate, { ...input, generationId: 'generation-A', owner: 'device:forged' }),
          { connectionId: 'generate-socket', pairedDeviceId: 'device-A' }
        )
      ).resolves.toMatchObject({ ok: true })
      await expect(
        test.dispatcher.dispatch(
          makeRequest(stop, {
            worktree: 'id:wt-1',
            generationId: 'generation-A',
            owner: 'device:forged'
          }),
          { connectionId: 'stop-socket', pairedDeviceId: 'device-A' }
        )
      ).resolves.toMatchObject({ ok: true })
      expect(chooseGenerate(test)).toHaveBeenCalledWith(...generationArgs, {
        owner: 'device:device-A',
        generationId: 'generation-A'
      })
      expect(chooseStop(test)).toHaveBeenCalledWith('id:wt-1', {
        owner: 'device:device-A',
        generationId: 'generation-A'
      })
    })

    it('uses caller identity when the transport has no pairedDeviceId field', async () => {
      const test = harness()
      await test.dispatcher.dispatch(
        makeRequest(generate, { ...input, generationId: 'generation-A' }),
        { caller: { kind: 'paired-device', deviceId: 'device-B' } }
      )
      await test.dispatcher.dispatch(
        makeRequest(stop, { worktree: 'id:wt-1', generationId: 'generation-A' }),
        { caller: { kind: 'local-cli' } }
      )
      expect(chooseGenerate(test)).toHaveBeenCalledWith(...generationArgs, {
        owner: 'device:device-B',
        generationId: 'generation-A'
      })
      expect(chooseStop(test)).toHaveBeenCalledWith('id:wt-1', {
        owner: 'local-cli',
        generationId: 'generation-A'
      })
    })

    it('accepts the transport-authenticated desktop caller without merging it with local CLI', async () => {
      const test = harness()
      await expect(
        test.dispatcher.dispatch(
          makeRequest(generate, { ...input, generationId: 'desktop-request' }),
          { caller: { kind: 'desktop' } }
        )
      ).resolves.toMatchObject({ ok: true })
      await expect(
        test.dispatcher.dispatch(
          makeRequest(stop, { worktree: 'id:wt-1', generationId: 'desktop-request' }),
          { caller: { kind: 'desktop' } }
        )
      ).resolves.toMatchObject({ ok: true })
      expect(chooseGenerate(test)).toHaveBeenCalledWith(...generationArgs, {
        owner: 'desktop',
        generationId: 'desktop-request'
      })
      expect(chooseStop(test)).toHaveBeenCalledWith('id:wt-1', {
        owner: 'desktop',
        generationId: 'desktop-request'
      })
    })

    it('rejects an identified request whose declared client has no authenticated owner', async () => {
      const test = harness()
      await expect(
        test.dispatcher.dispatch(
          makeRequest(generate, { ...input, generationId: 'generation-A' }),
          { clientKind: 'runtime' }
        )
      ).resolves.toMatchObject({
        ok: false,
        error: { message: 'A source control generation request needs an authenticated connection.' }
      })
      await expect(
        test.dispatcher.dispatch(
          makeRequest(stop, { worktree: 'id:wt-1', generationId: 'generation-A' }),
          { clientKind: 'runtime' }
        )
      ).resolves.toMatchObject({ ok: false })
      expect(chooseGenerate(test)).not.toHaveBeenCalled()
      expect(chooseStop(test)).not.toHaveBeenCalled()
    })

    it('preserves legacy call arity when generationId is absent', async () => {
      const test = harness()
      await test.dispatcher.dispatch(makeRequest(generate, input))
      await test.dispatcher.dispatch(makeRequest(stop, { worktree: 'id:wt-1' }))
      expect(chooseGenerate(test)).toHaveBeenCalledWith(...generationArgs.slice(0, -1))
      expect(chooseStop(test)).toHaveBeenCalledWith('id:wt-1')
    })

    it('keeps selected settings alongside the request identity', async () => {
      const test = harness()
      const params = { agentId: 'codex', model: 'test-model' }
      await test.dispatcher.dispatch(
        makeRequest(generate, {
          ...input,
          sourceControlAiResolvedParams: params,
          generationId: 'generation-A'
        })
      )
      expect(chooseGenerate(test)).toHaveBeenCalledWith(
        ...generationArgs.slice(0, -1),
        { sourceControlAiResolvedParams: params },
        { owner: 'local-cli', generationId: 'generation-A' }
      )
    })
  }
)
