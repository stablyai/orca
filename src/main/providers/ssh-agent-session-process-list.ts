import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyProcessInfo } from './types'
import { MAX_SSH_PTY_LIVE_ROSTER_ENTRIES } from './ssh-pty-live-roster'
import { admittedSshRelayPtyIdBytes } from './ssh-pty-wire-admission'

export const MAX_SSH_PTY_PROCESS_LIST_ENTRIES = MAX_SSH_PTY_LIVE_ROSTER_ENTRIES
export const MAX_SSH_PTY_PROCESS_OWNERS_PER_ENTRY = 256
export const MAX_SSH_PTY_PROCESS_LIST_OWNERS = MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
export const MAX_SSH_PTY_PROCESS_LIST_BYTES = 8 * 1024 * 1024
export const MAX_SSH_PTY_PROCESS_CWD_BYTES = 128 * 1024
export const MAX_SSH_PTY_PROCESS_TITLE_BYTES = 16 * 1024
const MAX_SSH_PTY_PROCESS_WORKTREE_ID_BYTES = 128 * 1024
const MAX_SSH_PTY_PROCESS_TERMINAL_HANDLE_BYTES = 1024
const MAX_SSH_PTY_PROCESS_WSL_DISTRO_BYTES = 4 * 1024

function stringBytes(value: unknown, maxBytes: number): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes <= maxBytes ? bytes : null
}

function optionalStringBytes(value: unknown, maxBytes: number): number | null {
  return value === undefined ? 0 : stringBytes(value, maxBytes)
}

function ownerBytes(owner: unknown): number | null {
  if (!isAgentSessionOwnerBinding(owner)) {
    return null
  }
  const strings = [
    owner.claim.keyId,
    owner.claim.identityDigest,
    owner.claim.worktreeScopeDigest,
    owner.claim.agent,
    owner.generation,
    owner.ptyId,
    owner.surface.worktreeId,
    owner.surface.tabId,
    owner.surface.leafId,
    owner.surface.terminalHandle
  ]
  return strings.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0)
}

function assertProcessList(
  sessions: unknown
): asserts sessions is (PtyProcessInfo & Record<string, unknown>)[] {
  if (!Array.isArray(sessions) || sessions.length > MAX_SSH_PTY_PROCESS_LIST_ENTRIES) {
    throw new Error('invalid_ssh_pty_process_list')
  }
  let aggregateBytes = 0
  let aggregateOwners = 0
  for (const session of sessions) {
    if (typeof session !== 'object' || session === null) {
      throw new Error('invalid_ssh_pty_process_list')
    }
    const idBytes = admittedSshRelayPtyIdBytes(session.id)
    const cwdBytes = stringBytes(session.cwd, MAX_SSH_PTY_PROCESS_CWD_BYTES)
    const titleBytes = stringBytes(session.title, MAX_SSH_PTY_PROCESS_TITLE_BYTES)
    const worktreeBytes = optionalStringBytes(
      session.worktreeId,
      MAX_SSH_PTY_PROCESS_WORKTREE_ID_BYTES
    )
    const terminalHandleBytes = optionalStringBytes(
      session.terminalHandle,
      MAX_SSH_PTY_PROCESS_TERMINAL_HANDLE_BYTES
    )
    const wslDistroBytes =
      session.wslDistro === null
        ? 0
        : optionalStringBytes(session.wslDistro, MAX_SSH_PTY_PROCESS_WSL_DISTRO_BYTES)
    if (
      idBytes === null ||
      cwdBytes === null ||
      titleBytes === null ||
      worktreeBytes === null ||
      terminalHandleBytes === null ||
      wslDistroBytes === null ||
      (session.incarnationId !== undefined && !isPtyIncarnationId(session.incarnationId))
    ) {
      throw new Error('invalid_ssh_pty_process_list')
    }
    aggregateBytes +=
      idBytes + cwdBytes + titleBytes + worktreeBytes + terminalHandleBytes + wslDistroBytes
    if (
      session.agentSessionOwners !== undefined &&
      (!Array.isArray(session.agentSessionOwners) ||
        session.agentSessionOwners.length > MAX_SSH_PTY_PROCESS_OWNERS_PER_ENTRY)
    ) {
      throw new Error('invalid_ssh_pty_process_list')
    }
    for (const owner of session.agentSessionOwners ?? []) {
      const bytes = ownerBytes(owner)
      if (bytes === null || owner.ptyId !== session.id) {
        throw new Error('agent_session_ownership_unknown')
      }
      aggregateBytes += bytes
    }
    aggregateOwners += session.agentSessionOwners?.length ?? 0
    if (
      aggregateBytes > MAX_SSH_PTY_PROCESS_LIST_BYTES ||
      aggregateOwners > MAX_SSH_PTY_PROCESS_LIST_OWNERS
    ) {
      throw new Error('invalid_ssh_pty_process_list')
    }
  }
}

export function mapSshPtyProcessList(
  sessions: unknown,
  toAppPtyId: (id: string) => string
): PtyProcessInfo[] {
  assertProcessList(sessions)
  return sessions.map((session) => {
    if (session.agentSessionOwners?.length && !isPtyIncarnationId(session.incarnationId)) {
      throw new Error('agent_session_ownership_unknown')
    }
    return {
      id: toAppPtyId(session.id),
      cwd: session.cwd,
      title: session.title,
      ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
      ...(session.worktreeId !== undefined ? { worktreeId: session.worktreeId } : {}),
      ...(session.terminalHandle !== undefined ? { terminalHandle: session.terminalHandle } : {}),
      ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {}),
      ...(session.agentSessionOwners !== undefined
        ? {
            agentSessionOwners: session.agentSessionOwners.map((owner) => {
              if (!isAgentSessionOwnerBinding(owner) || owner.ptyId !== session.id) {
                throw new Error('agent_session_ownership_unknown')
              }
              return {
                claim: {
                  digestVersion: owner.claim.digestVersion,
                  keyId: owner.claim.keyId,
                  identityDigest: owner.claim.identityDigest,
                  worktreeScopeDigest: owner.claim.worktreeScopeDigest,
                  agent: owner.claim.agent
                },
                generation: owner.generation,
                phase: owner.phase,
                ptyId: toAppPtyId(owner.ptyId),
                surface: {
                  worktreeId: owner.surface.worktreeId,
                  tabId: owner.surface.tabId,
                  leafId: owner.surface.leafId,
                  terminalHandle: owner.surface.terminalHandle
                }
              }
            })
          }
        : {})
    }
  })
}
