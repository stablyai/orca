import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { readAdmittedClaudeResumeConfig } from '../agent-hooks/server/claude-resume-context'
import { publishHostDescriptor } from '../runtime/host-descriptor'
import { createClaudeSessionResumePreparation } from './claude-session-resume-preparation'

let root: string
const runtime = { getRuntimeId: () => 'claude-resume-preparation' }
const origin = {
  installationId: 'installation',
  machineBinding: 'machine',
  host: { kind: 'local' as const }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-resume-preparation-'))
  publishHostDescriptor(runtime.getRuntimeId(), origin)
})
afterEach(async () => {
  publishHostDescriptor(runtime.getRuntimeId(), null)
  await rm(root, { recursive: true, force: true })
})

function account(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    managedAuthPath: '/legacy-unused',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

async function session(home: string): Promise<AgentProviderSessionMetadata> {
  const project = join(home, 'projects', 'project')
  await mkdir(project, { recursive: true })
  const transcriptPath = join(project, 'transcript.jsonl')
  await writeFile(transcriptPath, '{}\n')
  return { key: 'session_id', id: 'session', transcriptPath }
}

describe('host-owned Claude recovery preparation', () => {
  it('reads original registered A independently of selected B and refuses A after unregister', async () => {
    const home = join(root, 'claude-profiles', 'a', 'home')
    const providerSession = await session(home)
    const settings = {
      claudeManagedAccounts: [account('a'), account('b')],
      activeClaudeManagedAccountId: 'b'
    }
    const prepare = createClaudeSessionResumePreparation({
      dataRoot: root,
      getSettings: () => settings
    })
    const request = { providerSession, target: { runtime: 'host' as const } }
    await expect(prepare(request)).resolves.toEqual({
      outcome: 'resume',
      configDir: home,
      userHome: homedir(),
      source: 'managed'
    })
    settings.claudeManagedAccounts = [account('b')]
    await expect(prepare(request)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unknown-store'
    })
  })

  it('requires matching host-owned capture despite caller knowing the public origin and recipe', async () => {
    const home = join(root, 'external', '.claude')
    const providerSession = {
      ...(await session(home)),
      claudeConfig: { kind: 'explicit' as const, value: home, userHome: homedir() },
      claudeConfigOrigin: origin
    }
    const request = {
      providerSession,
      target: { runtime: 'host' as const },
      launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: home } }
    }
    const prepare = createClaudeSessionResumePreparation({ dataRoot: root, runtime })
    await expect(prepare(request)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unknown-store'
    })
    const admitted = createClaudeSessionResumePreparation({
      dataRoot: root,
      runtime,
      getAdmittedConfig: (requested, current) =>
        readAdmittedClaudeResumeConfig(
          [
            {
              paneKey: 'tab:leaf',
              worktreeId: 'workspace',
              connectionId: null,
              source: 'claude',
              hookEventName: 'Stop',
              providerSession,
              payload: { agentType: 'claude', state: 'done', prompt: '' }
            }
          ],
          requested,
          current
        )
    })
    await expect(admitted(request)).resolves.toEqual({
      outcome: 'resume',
      configDir: home,
      userHome: homedir(),
      source: 'capture'
    })
    await expect(
      admitted({ ...request, launchEnv: { HOME: join(root, 'other-home') } })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'store-mismatch' })
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: origin.installationId,
      machineBinding: 'other-machine'
    })
    await expect(admitted(request)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'store-mismatch'
    })
  })
})
