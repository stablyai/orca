import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcRequest } from '../../../core'
import '../../../../orca-runtime'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

import { GITLAB_METHODS } from './gitlab'
import '../../../../../../shared/rpc-contract/gitlab-params'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('gitlab RPC methods', () => {
  // Bound excerpts before serialization: WS/relay frames over 1 MiB close the connection (#7732).
  it('bounds the job trace before it crosses the transport when logExcerpt is set', async () => {
    const noisyTrace = [
      'section_start:1699000000:build\r\u001b[0K$ pnpm build',
      ...Array.from({ length: 400 }, (_, index) => `line ${index}`),
      'ERROR: Job failed: exit code 1'
    ].join('\n')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getGitLabRepoJobTrace: vi.fn().mockResolvedValue({ ok: true, trace: noisyTrace })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })

    const raw = await dispatcher.dispatch(
      makeRequest('gitlab.jobTrace', { repo: 'id:repo-1', jobId: 99 })
    )
    const excerpt = await dispatcher.dispatch(
      makeRequest('gitlab.jobTrace', { repo: 'id:repo-1', jobId: 99, logExcerpt: true })
    )

    expect((raw as { result: { trace: string } }).result.trace).toBe(noisyTrace)
    const bounded = (excerpt as { result: { trace: string } }).result.trace
    expect(bounded).toContain('ERROR: Job failed: exit code 1')
    expect(bounded).not.toContain('section_start')
    expect(bounded).not.toContain('line 0\n')
  })
})
