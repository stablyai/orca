import 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'node:path'
import 'node:fs'
import 'node:os'
import '../../../daemon/pty-subprocess/spawn-environment'
import '../../../providers/local-pty/local-pty-spawn-environment'
import { assemblePtySpawnEnvDeletions } from './spawn-options-assembly'
import '../../../managed-data-accounts/launch-environment'
import '../ipc/spawn-options'
import '../ipc/spawn-state'

import '../runtime/spawn-options'
import '../runtime/spawn-state'

import type * as ServiceModule from '../../../managed-data-accounts/service'
import { MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS } from '../../../../shared/agent-launch/environment/managed-data-account-environment'
import '../../../../shared/agent-launch/environment/managed-data-account-resume'
import '../../../managed-data-accounts/service'
import '../../../opencode/opencode-private-server'
import '../../../../shared/secure-storage/secure-file'

const selected = vi.hoisted(() => {
  const value: Record<string, string> = {}
  return { value }
})
vi.mock('../../../managed-data-accounts/service', async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceModule>()
  const service = new actual.ManagedDataAccountService('test-managed-root')
  vi.spyOn(service, 'launchEnvironment').mockImplementation(() => selected.value)
  return { ...actual, getManagedDataAccountService: () => service }
})

beforeEach(() => {
  for (const key of [
    ...MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS,
    'ORCA_DATA_ACCOUNT_DATA_HOME',
    'ORCA_DATA_ACCOUNT_STATE_HOME',
    'ORCA_DATA_ACCOUNT_PROVIDER',
    'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
  ]) {
    vi.stubEnv(key, undefined)
  }
  selected.value = {}
})
afterEach(() => vi.unstubAllEnvs())

describe('independent pane agent session environments', () => {
  it('canonicalizes explicit Windows stamps for old receivers and keeps caller deletions authoritative', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const explicit = { claude_code_messaging_socket: '', SAFE_VALUE: 'kept' }
      const input = {
        env: explicit,
        callerEnvToDelete: undefined,
        agentTeamsEnvToDelete: [],
        isDaemonHostSpawn: true,
        connectionId: null,
        skipCodexHomeEnv: false,
        stripInheritedOrcaCodexHome: false,
        codexResumeHomeSelected: false,
        settings: undefined
      }
      const kept = assemblePtySpawnEnvDeletions(input)
      expect(kept.env).toEqual({ CLAUDE_CODE_MESSAGING_SOCKET: '', SAFE_VALUE: 'kept' })
      expect(kept.envToDelete).not.toContain('CLAUDE_CODE_MESSAGING_SOCKET')
      expect(kept.envToDelete).toContain('CLAUDE_CODE_MESSAGING_TOKEN')
      const deleted = assemblePtySpawnEnvDeletions({
        ...input,
        callerEnvToDelete: ['Claude_Code_Messaging_Socket']
      })
      expect(deleted.env).toEqual({ SAFE_VALUE: 'kept' })
      expect(deleted.envToDelete).toContain('CLAUDE_CODE_MESSAGING_SOCKET')
      expect(explicit).toEqual({ claude_code_messaging_socket: '', SAFE_VALUE: 'kept' })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })
})
