import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'
import { isUnreadableError, writeSecureFile } from '../../shared/secure-storage/secure-file'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  MAX_AGENT_API_KEYS,
  agentApiKeyEnvNameError,
  agentApiKeyValueError,
  isAgentApiKeyAgent,
  isAgentApiKeyHostScope,
  selectAgentApiKeys,
  type AgentApiKeyProtection,
  type AgentApiKeySaveRequest,
  type AgentApiKeySummary
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import { registerRedactedSecretValue } from '../observability/redactor'

type StoredAgentApiKey = AgentApiKeySummary & { ciphertext: string }

type AgentApiKeyFile = {
  version: 1
  format: 'electron-safe-storage-v1'
  keys: StoredAgentApiKey[]
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const UNREADABLE_ERROR = 'The saved API keys could not be read; nothing was changed.'

export class AgentApiKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentApiKeyError'
  }
}

function isStoredKey(value: unknown): value is StoredAgentApiKey {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const key = value as Partial<StoredAgentApiKey>
  return (
    typeof key.id === 'string' &&
    isAgentApiKeyAgent(key.agent) &&
    typeof key.envName === 'string' &&
    agentApiKeyEnvNameError(key.envName) === null &&
    isAgentApiKeyHostScope(key.hostScope) &&
    typeof key.hint === 'string' &&
    typeof key.updatedAt === 'number' &&
    typeof key.ciphertext === 'string'
  )
}

function summaryOf({ ciphertext: _ciphertext, ...summary }: StoredAgentApiKey): AgentApiKeySummary {
  return summary
}

/** Desktop-only vault of agent API keys, sealed by the OS keychain. Values leave it only as launch env. */
export class AgentApiKeyStore {
  /** This store is the file's only writer, so launches reuse the parsed file instead of re-reading it. */
  private cached: AgentApiKeyFile | null = null

  constructor(private readonly filePath: string) {}

  /** Null means unreadable, never empty: a denied, corrupt or newer-format file must not be overwritten. */
  private read(): AgentApiKeyFile | null {
    if (this.cached) {
      return this.cached
    }
    const empty: AgentApiKeyFile = { version: 1, format: 'electron-safe-storage-v1', keys: [] }
    try {
      if (!existsSync(this.filePath)) {
        return (this.cached = empty)
      }
      if (statSync(this.filePath).size > MAX_FILE_BYTES) {
        return null
      }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AgentApiKeyFile>
      if (
        parsed?.version === 1 &&
        parsed.format === 'electron-safe-storage-v1' &&
        Array.isArray(parsed.keys)
      ) {
        return (this.cached = { ...empty, keys: parsed.keys.filter(isStoredKey) })
      }
    } catch (error) {
      if (!isUnreadableError(error)) {
        console.warn('[agent-api-keys] Saved keys file is unreadable; leaving it untouched')
      }
    }
    return null
  }

  private write(file: AgentApiKeyFile): void {
    writeSecureFile(this.filePath, JSON.stringify(file, null, 2))
    this.cached = file
  }

  protection(): AgentApiKeyProtection {
    const store = getSecretStore()
    if (!store.isEncryptionAvailable()) {
      return {
        available: false,
        reason:
          store.describeProtectionGap() ??
          'The OS keychain is unavailable, so Orca cannot store API keys.'
      }
    }
    // Why: a Linux basic_text "seal" is readable by anyone with the file; refuse rather than pretend.
    const gap = store.describeProtectionGap()
    return gap ? { available: false, reason: gap } : { available: true }
  }

  list(): AgentApiKeySummary[] {
    return (this.read()?.keys ?? []).map(summaryOf)
  }

  save(request: AgentApiKeySaveRequest, now = Date.now()): AgentApiKeySummary {
    if (!isAgentApiKeyAgent(request.agent)) {
      throw new AgentApiKeyError('Choose an agent for this key.')
    }
    const envName = typeof request.envName === 'string' ? request.envName.trim() : ''
    const nameError = agentApiKeyEnvNameError(envName)
    if (nameError) {
      throw new AgentApiKeyError(nameError)
    }
    if (!isAgentApiKeyHostScope(request.hostScope)) {
      throw new AgentApiKeyError('Choose at least one host.')
    }
    const value = typeof request.value === 'string' ? request.value.trim() : undefined
    if (value !== undefined) {
      const valueError = agentApiKeyValueError(envName, value)
      if (valueError) {
        throw new AgentApiKeyError(valueError)
      }
    }
    const protection = this.protection()
    if (!protection.available) {
      throw new AgentApiKeyError(protection.reason)
    }
    const file = this.read()
    if (!file) {
      throw new AgentApiKeyError(UNREADABLE_ERROR)
    }
    const existing = request.id ? file.keys.find((key) => key.id === request.id) : undefined
    if (request.id && !existing) {
      throw new AgentApiKeyError('That key was removed. Add it again.')
    }
    if (!existing && value === undefined) {
      throw new AgentApiKeyError('Paste the key.')
    }
    if (!existing && file.keys.length >= MAX_AGENT_API_KEYS) {
      throw new AgentApiKeyError(`Orca keeps at most ${MAX_AGENT_API_KEYS} API keys.`)
    }
    if (existing && value === undefined && existing.envName !== envName) {
      // The old value belongs to the old variable; renaming must not silently move it.
      throw new AgentApiKeyError('Paste the key again when you change its variable.')
    }
    const next: StoredAgentApiKey = {
      id: existing?.id ?? randomUUID(),
      agent: request.agent,
      envName,
      hostScope:
        request.hostScope.kind === 'all'
          ? { kind: 'all' }
          : { kind: 'hosts', hostIds: [...new Set(request.hostScope.hostIds)] },
      hint: value !== undefined ? value.slice(-4) : (existing?.hint ?? ''),
      updatedAt: now,
      ciphertext:
        value !== undefined
          ? getSecretStore().encryptString(value).toString('base64')
          : existing!.ciphertext
    }
    if (value !== undefined) {
      registerRedactedSecretValue(value)
    }
    file.keys = existing
      ? file.keys.map((key) => (key.id === existing.id ? next : key))
      : [...file.keys, next]
    this.write(file)
    return summaryOf(next)
  }

  remove(id: string): void {
    const file = this.read()
    if (!file) {
      throw new AgentApiKeyError(UNREADABLE_ERROR)
    }
    const keys = file.keys.filter((key) => key.id !== id)
    if (keys.length !== file.keys.length) {
      this.write({ ...file, keys })
    }
  }

  /** The env one launch of `agent` on `hostId` gets. Keys that fail to unseal are skipped, never sent half-read. */
  launchEnv(agent: TuiAgent, hostId: ExecutionHostId): Record<string, string> {
    const keys = this.read()?.keys ?? []
    if (keys.length === 0) {
      return {}
    }
    const store = getSecretStore()
    if (!store.isEncryptionAvailable()) {
      return {}
    }
    const env: Record<string, string> = {}
    for (const key of selectAgentApiKeys(keys, agent, hostId)) {
      try {
        const value = store.decryptString(Buffer.from(key.ciphertext, 'base64'))
        registerRedactedSecretValue(value)
        env[key.envName] = value
      } catch {
        console.warn(`[agent-api-keys] Could not unseal ${key.envName}; launching without it`)
      }
    }
    return env
  }
}
