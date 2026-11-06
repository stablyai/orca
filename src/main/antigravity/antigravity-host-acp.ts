// The execution host's own `agy acp`: preferred for new chats when it answers as a compatible server.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
import { initializeAntigravityAcp } from './antigravity-acp-runtime-probe'

/** First release verified with Orca chats; it also leaves the chat's folder untouched. */
export const ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION = '1.5.2'
/** agy keeps its sign-in and conversations here and ignores GEMINI_HOME, so this only pins the chat. */
const AGY_HOME_FOLDER = '.gemini'
const PROBE_TIMEOUT_MS = 20_000

export function isCompatibleAntigravityHostAcp(initialized: InitializeResponse): boolean {
  const capabilities = initialized.agentCapabilities
  const version = initialized.agentInfo?.version ?? ''
  return (
    initialized.agentInfo?.name === 'Antigravity ACP Server' &&
    isValidAppVersion(version) &&
    compareAppVersions(version, ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION) >= 0 &&
    initialized.protocolVersion === 1 &&
    capabilities?.loadSession === true &&
    Boolean(capabilities.sessionCapabilities?.resume)
  )
}

/** The account home of chats pinned to the host's agy and its own sign-in. */
export function antigravityHostAccountHome(homePath: string): AgentSessionAccountHome {
  return { variable: 'GEMINI_HOME', path: join(homePath, AGY_HOME_FOLDER) }
}

/** Managed chats pin `<userData>/antigravity-chat`, so only this folder name selects the host's agy. */
export function isAntigravityHostAccountHome(home: AgentSessionAccountHome): boolean {
  return (
    isLegacyAgentSessionAccountHome(home) &&
    home.variable === 'GEMINI_HOME' &&
    home.path.split(/[\\/]+/).findLast(Boolean) === AGY_HOME_FOLDER
  )
}

// Keyed by the binary's identity so an upgrade or reinstall is checked again.
const checks = new Map<string, { identity: string; answer: Promise<boolean> }>()

/** Whether `command acp` initializes as a compatible server; failed checks are retried next time. */
export async function antigravityHostAcpAnswers(
  command: string,
  env: Record<string, string>,
  envToDelete: string[]
): Promise<boolean> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const cached = checks.get(command)
  if (cached?.identity === identity) {
    return cached.answer
  }
  const answer = initializeAntigravityAcp(
    () => ({ command, args: ['acp'], env, envToDelete }),
    PROBE_TIMEOUT_MS
  ).then(isCompatibleAntigravityHostAcp, () => {
    if (checks.get(command)?.answer === answer) {
      checks.delete(command)
    }
    return false
  })
  checks.set(command, { identity, answer })
  return answer
}
