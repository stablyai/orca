import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import {
  AGENT_SESSION_CLAIM_DIGEST_VERSION,
  type AgentSessionExecutionClaim
} from '../../shared/agent-session-host-authority'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../shared/agent-session-resume'

const COORDINATION_KEY_BYTES = 32
const COORDINATION_KEY_FILE = 'agent-session-authority.key'
const TRANSCRIPT_PATH_MAX_BYTES = 16 * 1024

export type ProviderExecutionNamespace = {
  machine: string
  principal: string
  container: string
  providerRoot: string
}

export type CanonicalAgentSessionIdentity = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

function encodeFields(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = []
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    chunks.push(length, value)
  }
  return Buffer.concat(chunks)
}

function canonicalPathForPlatform(value: string): string {
  const canonical = normalize(realpathSync(value))
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical
}

export function canonicalizeAgentSessionIdentity(
  agent: unknown,
  rawProviderSession: unknown
): CanonicalAgentSessionIdentity {
  if (!isResumableTuiAgent(agent)) {
    throw new Error('agent_session_identity_required')
  }
  const providerSession = normalizeAgentProviderSession(rawProviderSession)
  if (!providerSession || !getAgentResumeArgv(agent, providerSession)) {
    throw new Error('agent_session_identity_required')
  }
  if (agent !== 'pi') {
    return { agent, providerSession }
  }
  const transcriptPath = providerSession.transcriptPath
  if (
    !transcriptPath ||
    !isAbsolute(transcriptPath) ||
    Buffer.byteLength(transcriptPath, 'utf8') > TRANSCRIPT_PATH_MAX_BYTES
  ) {
    throw new Error('agent_session_identity_required')
  }
  const canonicalTranscriptPath = canonicalPathForPlatform(transcriptPath)
  if (!statSync(canonicalTranscriptPath).isFile()) {
    throw new Error('agent_session_identity_required')
  }
  return {
    agent,
    providerSession: { ...providerSession, transcriptPath: canonicalTranscriptPath }
  }
}

export class AgentSessionClaimSigner {
  readonly keyId: string

  constructor(
    private readonly authorityDomainId: string,
    private readonly key: Buffer
  ) {
    if (key.length !== COORDINATION_KEY_BYTES) {
      throw new Error('agent_session_ownership_unknown')
    }
    this.keyId = createHash('sha256').update(key).digest('base64url').slice(0, 22)
  }

  createClaim(args: {
    namespace: ProviderExecutionNamespace
    identity: CanonicalAgentSessionIdentity
    canonicalWorktreeId: string
  }): AgentSessionExecutionClaim {
    const namespaceFields = [
      args.namespace.machine,
      args.namespace.principal,
      args.namespace.container,
      args.namespace.providerRoot
    ]
    const identityFields = [
      'orca-agent-session-claim-v1',
      this.authorityDomainId,
      ...namespaceFields,
      args.identity.agent,
      args.identity.providerSession.key,
      args.identity.providerSession.id,
      args.identity.agent === 'pi' ? (args.identity.providerSession.transcriptPath ?? '') : ''
    ]
    const worktreeFields = [
      'orca-agent-session-worktree-v1',
      this.authorityDomainId,
      ...namespaceFields,
      args.canonicalWorktreeId
    ]
    return {
      digestVersion: AGENT_SESSION_CLAIM_DIGEST_VERSION,
      keyId: this.keyId,
      identityDigest: createHmac('sha256', this.key)
        .update(encodeFields(identityFields))
        .digest('base64url'),
      worktreeScopeDigest: createHmac('sha256', this.key)
        .update(encodeFields(worktreeFields))
        .digest('base64url'),
      agent: args.identity.agent
    }
  }
}

export function loadAgentSessionClaimSigner(
  profileDirectory: string,
  authorityDomainId: string
): AgentSessionClaimSigner {
  const keyPath = join(profileDirectory, COORDINATION_KEY_FILE)
  mkdirSync(dirname(keyPath), { recursive: true })
  let key: Buffer
  try {
    key = readFileSync(keyPath)
  } catch {
    const candidate = randomBytes(COORDINATION_KEY_BYTES)
    let fd: number | null = null
    try {
      fd = openSync(keyPath, 'wx', 0o600)
      writeFileSync(fd, candidate)
      key = candidate
    } catch {
      key = readFileSync(keyPath)
    } finally {
      if (fd !== null) {
        closeSync(fd)
      }
    }
  }
  // Why: a replaced/corrupt key could make a surviving owner look absent;
  // refuse authority instead of silently minting an incomparable namespace.
  if (key.length !== COORDINATION_KEY_BYTES) {
    throw new Error('agent_session_ownership_unknown')
  }
  return new AgentSessionClaimSigner(authorityDomainId, key)
}

export function createEphemeralAgentSessionClaimSigner(
  authorityDomainId: string
): AgentSessionClaimSigner {
  return new AgentSessionClaimSigner(authorityDomainId, randomBytes(COORDINATION_KEY_BYTES))
}
