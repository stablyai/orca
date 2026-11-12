import { createHash } from 'node:crypto'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionExecutionEvidence } from '../../../../shared/agent-session/agent-session-execution-evidence'
import type { CodexSession } from './codex-structured-session-state'

const INCLUDED_PLANS = new Set(['pro', 'promax', 'plus', 'business', 'team', 'enterprise', 'edu'])
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()

function roots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(text)
}

function sandboxEvidence(
  session: CodexSession
): AgentSessionExecutionEvidence['permissions'] | null {
  const permissions = session.permissions
  const sandbox = permissions?.acquiredSandbox
  if (
    !permissions?.launchSandboxIntact ||
    !sandbox ||
    sandbox.networkAccess !== false ||
    !text(permissions.approvalPolicy) ||
    !text(permissions.approvalsReviewer) ||
    (sandbox.type !== 'readOnly' && sandbox.type !== 'workspaceWrite')
  ) {
    return null
  }
  const access = readRecord(sandbox.type === 'readOnly' ? sandbox.access : sandbox.readOnlyAccess)
  if (
    access.type !== 'restricted' ||
    typeof access.includePlatformDefaults !== 'boolean' ||
    !roots(access.readableRoots) ||
    access.readableRoots.length === 0 ||
    (sandbox.type === 'workspaceWrite' &&
      (!sandbox.excludeSlashTmp || !sandbox.excludeTmpdirEnvVar))
  ) {
    return null
  }
  return {
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandbox: {
      type: sandbox.type,
      networkAccess: false,
      readableRoots: [...access.readableRoots],
      writableRoots: sandbox.type === 'workspaceWrite' ? [...sandbox.writableRoots] : [],
      includePlatformDefaults: access.includePlatformDefaults
    }
  }
}

export function readCodexSessionExecutionEvidence(
  sessions: ReadonlyMap<string, CodexSession>,
  now: () => number
): NonNullable<StructuredAgentSessionAdapter['readExecutionEvidence']> {
  return async ({ sessionId, fence, signal }) => {
    const session = sessions.get(sessionId)
    const settings = session?.appliedSettings?.read()
    const permissions = session && sandboxEvidence(session)
    const cwd = session?.permissions?.reportedCwd
    if (
      !session ||
      session.modelProvider !== 'openai' ||
      session.ended ||
      session.connection.closed ||
      session.fence !== fence ||
      session.authRevision === undefined ||
      !settings ||
      !text(settings.model) ||
      !text(settings.effort) ||
      !permissions ||
      !text(cwd) ||
      signal?.aborted
    ) {
      return null
    }
    const revision = session.authRevision
    const generation = session.acquisitionGeneration
    const isCurrent = () =>
      !signal?.aborted &&
      sessions.get(sessionId) === session &&
      !session.ended &&
      !session.connection.closed &&
      session.modelProvider === 'openai' &&
      session.authRevision === revision &&
      session.acquisitionGeneration === generation &&
      session.fence === fence &&
      session.permissions?.reportedCwd === cwd &&
      session.appliedSettings?.read() === settings &&
      JSON.stringify(sandboxEvidence(session)) === JSON.stringify(permissions)
    try {
      const reply = await session.connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 2_000 }
      )
      const account = readRecord(readRecord(reply).account)
      const identity = account.id || account.email
      if (
        account.type !== 'chatgpt' ||
        !text(identity) ||
        !text(account.planType) ||
        !INCLUDED_PLANS.has(account.planType) ||
        !isCurrent()
      ) {
        return null
      }
      const evidence: AgentSessionExecutionEvidence = {
        version: 1,
        agent: 'codex',
        modelProvider: 'openai',
        sessionId,
        runtimeFence: fence,
        acquisitionGeneration: generation,
        observedAt: now(),
        cwd,
        model: settings.model,
        effort: settings.effort,
        account: {
          type: 'chatgpt',
          plan: account.planType,
          fingerprint: `codex:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}`
        },
        permissions
      }
      return { evidence, isCurrent }
    } catch {
      return null
    }
  }
}
