import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'

it('releases a prepared fork resource before returning a no-effects Default refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-create-refusal-'))
  const resource = await open(join(root, 'prepared-copy'), 'w+')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal consumes only the resolved intent and Settings; the file is the disposable fork resource.
  const runtime = {
    resolveStructuredAgentSessionCreateIntent: async () => ({
      agent: 'claude',
      provider: 'claude',
      location: { workspaceId: 'workspace', executionHostId: 'local' },
      omitEffort: true,
      fork: { prepared: { close: () => resource.close() } }
    }),
    requireStore: () => ({
      getSettings: () => ({ agentCmdOverrides: { claude: 'claude --effort high' } })
    })
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no commit is reached; preparation reads only this operation lookup.
  const host = {
    deps: { store: { getOperationRow: () => null } }
  } as unknown as StructuredAgentSessionHost
  try {
    const result = await resolveUncommittedStructuredCreate(
      () =>
        prepareStructuredAgentSessionCreateForWorktree({
          runtime,
          ensureHost: async () => host,
          envelope: {
            sessionId: 'child',
            clientOperationId: 'create',
            expectedRuntimeFence: null,
            payloadFingerprint: 'intent'
          },
          worktree: 'workspace',
          agent: 'claude',
          caller: { callerKey: 'caller' },
          forkFrom: { sessionId: 'source', throughItemId: 'answer' },
          atRest: true
        }),
      'claude'
    )
    expect(result).toHaveProperty('refusal')
    await expect(resource.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    await resource.close()
    await rm(root, { recursive: true, force: true })
  }
})
