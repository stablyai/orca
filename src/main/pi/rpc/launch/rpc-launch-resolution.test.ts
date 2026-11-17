import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { createPiRpcLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY } from '../../managed-extensions/agent-status/agent-status-subagent-roster-source'
import { ORCA_PI_AGENT_STATUS_EXTENSION_FILE } from '../../managed-extensions/agent-status/agent-status-extension-source'

const accountDirs: string[] = []
afterEach(() => {
  for (const dir of accountDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function launchPi(managedExtensionsEnabled: boolean): Promise<string> {
  const accountDir = mkdtempSync(join(tmpdir(), 'orca-pi-chat-agent-'))
  accountDirs.push(accountDir)
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: 'pi',
    providerHandleChain: [],
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: accountDir }
  }
  const resolve = createPiRpcLaunchResolver({
    managedExtensionsEnabled: () => managedExtensionsEnabled,
    store: { getRecord: () => record, pinLaunchDirectory: async () => record },
    resolveWorkspacePath: async () => accountDir,
    resolveCommand: () => '/host/bin/pi',
    probeVersion: async () => ({ version: '0.84.0' }),
    ensureBackgroundWorkBridge: async () => null
  })
  await resolve({
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: record.location.executionHostId,
    agent: 'pi',
    providerHandle: null
  })
  return join(accountDir, 'extensions', ORCA_PI_AGENT_STATUS_EXTENSION_FILE)
}

describe('Pi chat managed extensions', () => {
  it('installs the status extension that reports subagents into the chat agent dir', async () => {
    const statusExtension = await launchPi(true)
    expect(readFileSync(statusExtension, 'utf8')).toContain(PI_NATIVE_CHAT_SUBAGENTS_STATUS_KEY)
  })

  it('writes nothing when agent status hooks are off', async () => {
    const statusExtension = await launchPi(false)
    expect(existsSync(statusExtension)).toBe(false)
  })
})
