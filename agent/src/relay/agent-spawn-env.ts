/**
 * agent-spawn-env.ts — buildAgentEnv (testable with mock credStore) for
 * agent-spawner.ts (CR-AG-12).
 *
 * Split out of agent-spawner.ts (oxlint max-lines) — see that file's header
 * for the full picture of how these pieces fit together.
 *
 * ORCH-003: Removed 'placeholder-key'. Now reads the real encryptedBlob from
 * the credential store (Layer 1 ciphertext from browser). Injects only the
 * env var that corresponds to the specific model's provider.
 *
 * NOTE on credential architecture (TDD-AG-09):
 *   Layer 1: Browser encrypts apiKey with SubtleCrypto → encryptedBlob
 *   Layer 2: Dev Server double-encrypts encryptedBlob → .enc file
 *   readDecryptedKey() decrypts Layer 2 → returns encryptedBlob (Layer 1)
 *   The Orca Server is responsible for injecting resolvedApiKey (plaintext)
 *   via the spawn request params when it has the Layer 1 session key.
 *   If resolvedApiKey is provided, it takes priority over credStore lookup.
 *
 * BUG-AG-HLD-002: there is NO fallback that reads the credential store and
 * uses its value as the API key. readDecryptedKey() only strips Layer 2 —
 * its return value is still Layer-1 ciphertext (agent-credential-store.ts:4-10:
 * "the agent never sees the plaintext API key"). If resolvedApiKey is absent,
 * buildAgentEnv() throws instead of injecting a value that is certainly wrong.
 * readDecryptedKey() is still called below, but only to distinguish "no
 * credential at all" from "credential exists but Orca Server forgot to
 * resolve+forward resolvedApiKey" in the error message.
 *
 * @module relay/agent-spawn-env
 */
import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'
import { readDecryptedKey } from './agent-credential-store'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { AgentBinarySpec, AgentSpawnRequest } from './agent-spawn-types'

export type AgentEnvRequest = {
  accountId: string
  userId: string
  taskId: string
  projectId?: string
  cwd: string
  model?: string
  // BUG-AG-HLD-008: KHÔNG dùng để build CLI args — trust preset thật được đọc
  // từ AgentSpawnRequest.trustPreset trong buildAgentArgs(), không phải ở đây.
  // Giữ field này chỉ vì AgentEnvRequest hiện chưa có caller production nào
  // construct nó (xem SOL-AG-HLD-008 §2) — cân nhắc xoá hẳn AgentEnvRequest
  // trong 1 refactor riêng nếu vẫn không có caller thật sau khi fix này merge.
  trustPreset?: string
  extraEnv?: Record<string, string>
}

export async function buildAgentEnv(
  req: AgentEnvRequest | AgentSpawnRequest,
  spec: AgentBinarySpec,
  config: AgentConfig,
  resolvedApiKey: string | null,
  log?: AgentLogger,
  parentSpanId?: string // NEW — CR-TRACE-016: correlates the fallback
  // credential-read span with the agent:spawn span
  // that triggered it (see agent-credential-store.ts)
): Promise<Record<string, string>> {
  // Normalise: AgentSpawnRequest uses taskId/userId/accountId directly
  const accountId = 'accountId' in req ? req.accountId : ''
  const userId = 'userId' in req ? req.userId : ''
  const taskId = 'taskId' in req ? req.taskId : ''
  const projectId = 'projectId' in req ? ((req as AgentEnvRequest).projectId ?? '') : ''
  const cwd = 'cwd' in req ? (req.cwd ?? config.workDir) : config.workDir

  const base: Record<string, string> = {
    HOME: process.env.HOME ?? '/tmp',
    PATH: config.toolPath ?? process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    ORCA_AGENT_CWD: cwd,
    ORCA_ACCOUNT_ID: accountId,
    ORCA_TASK_ID: taskId,
    ORCA_USER_ID: userId,
    ...(projectId ? { ORCA_PROJECT_ID: projectId } : {}),
    // Per-user GitHub/GitLab config dirs to isolate credentials across agents
    GH_CONFIG_DIR: `${process.env.HOME ?? '/tmp'}/.config/gh/${userId}/`,
    GLAB_CONFIG_DIR: `${process.env.HOME ?? '/tmp'}/.config/glab-cli/${userId}/`
  }

  // Inject API key for all providers (forward resolvedApiKey to all known env vars)
  // so that multi-provider agents can use whichever they need.
  if (resolvedApiKey) {
    base['ANTHROPIC_API_KEY'] = resolvedApiKey
    base['OPENAI_API_KEY'] = resolvedApiKey
    base['GEMINI_API_KEY'] = resolvedApiKey
  } else if (spec.apiKeyEnvVar && accountId) {
    // No resolvedApiKey from Orca Server. NEVER fall back to the Layer-1
    // ciphertext (readDecryptedKey() only strips Layer 2) — a ciphertext
    // "API key" fails auth silently and confusingly downstream. Fail fast
    // here instead, with a message that distinguishes the two real causes.
    const logFn = log ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    }
    const blob = await readDecryptedKey(accountId, config, logFn as AgentLogger, parentSpanId)
    const err = new Error(
      blob
        ? `buildAgentEnv: a credential exists for accountId=${accountId} but no plaintext ` +
            `resolvedApiKey was provided. The Dev Server agent cannot decrypt the Layer-1 ` +
            `(browser-encrypted) credential blob itself — Orca Server must resolve it and pass ` +
            `"resolvedApiKey" in the agent.spawn RPC params.`
        : `buildAgentEnv: no credential found for accountId=${accountId} and no resolvedApiKey ` +
            `provided. Configure an AI provider account in Orca settings, or ensure Orca Server ` +
            `passes "resolvedApiKey" when spawning this agent.`
    )
    Object.assign(err, { agentErrorCode: AgentErrorCode.PermissionDenied })
    logFn.warn?.(err.message)
    throw err
  }

  // Local inference servers (Ollama, vLLM, LM Studio)
  if (spec.localInference) {
    base.OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
    base.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'http://localhost:8000/v1'
  }

  // Extra env overrides from caller
  const extra = 'extraEnv' in req ? ((req as AgentEnvRequest).extraEnv ?? {}) : {}
  return { ...base, ...extra }
}
