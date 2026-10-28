import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { NativeCodexResumePreparation } from '../codex/codex-ai-vault-session-resume'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { codexConversationStore } from '../codex/codex-launch-home'
import type { StructuredAgentSessionAdoption } from './structured-agent-session-history-adoption'
import { admitTranscriptPath } from './transcript-path-admission'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export async function prepareCodexAdoption(
  source: StructuredAgentSessionAdoption,
  providerSessionId: string,
  prepare: NativeCodexResumePreparation | undefined,
  recognizedHomes: readonly AgentSessionAccountHome[]
): Promise<StructuredAgentSessionAdoption> {
  if (!prepare || !isLegacyAgentSessionAccountHome(source.accountHome)) {
    return source
  }
  const nativeSystemHomePath = getSystemCodexHomePath()
  const result = await prepare(
    {
      agent: 'codex',
      sessionId: providerSessionId,
      filePath: source.transcriptPath,
      codexHome: source.accountHome.path,
      executionHostId: 'local'
    },
    nativeSystemHomePath
  )
  const home = result.useRealCodexHome ? nativeSystemHomePath : result.substituteCodexHome
  if (
    !home ||
    normalizeRuntimePathForComparison(home) ===
      normalizeRuntimePathForComparison(source.accountHome.path)
  ) {
    return source
  }
  if (
    !result.useRealCodexHome &&
    !recognizedHomes.some(
      (candidate) =>
        isLegacyAgentSessionAccountHome(candidate) &&
        normalizeRuntimePathForComparison(codexConversationStore(candidate.path)) ===
          normalizeRuntimePathForComparison(codexConversationStore(home))
    )
  ) {
    throw new Error('The prepared conversation account is not recognized on this host.')
  }
  const original = await admitTranscriptPath(
    join(source.accountHome.path, 'sessions'),
    source.transcriptPath
  )
  if (!original?.relativePath) {
    throw new Error('The conversation path could not be verified.')
  }
  const prepared = await admitTranscriptPath(
    join(home, 'sessions'),
    join(home, 'sessions', original.relativePath)
  )
  if (!prepared || !(await stat(prepared.path)).isFile()) {
    throw new Error('The prepared conversation history is unavailable.')
  }
  return { accountHome: { variable: 'CODEX_HOME', path: home }, transcriptPath: prepared.path }
}
