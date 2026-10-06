import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import {
  createClaudeProfileAdapter,
  createCodexProfileAdapter
} from '../agent-profiles/provider-adapters'
import type { AgentLaunchProfile } from '../../shared/agent-launch-profile'
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  }
}))
import { registerAgentProfileHandlers } from './agent-profiles'
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  handlers.clear()
})
describe('profile IPC singleton management', () => {
  it.each(['claude', 'codex'] as const)(
    'validates %s preview/save/unlink and uses the launch service mutation queue',
    async (agent) => {
      root = await mkdtemp(join(tmpdir(), 'profile-ipc-'))
      const home = join(root, 'home')
      const executable = join(root, 'cli')
      await mkdir(home)
      await writeFile(executable, 'synthetic')
      await chmod(executable, 0o700)
      let profiles: AgentLaunchProfile[] = []
      const inspectManaged = vi.fn(async () => ({
        home,
        identity: { kind: 'verified' as const, subject: 'a', displayName: 'Account A' }
      }))
      const prepareManaged = vi.fn(async () => ({
        home,
        envPatch: {},
        envToDelete: [],
        release: () => {}
      }))
      const callbacks = { inspectManaged, prepareManaged }
      const service = new AgentProfileConnectionService({
        host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/bash' },
        adapters: {
          claude: createClaudeProfileAdapter(callbacks),
          codex: createCodexProfileAdapter(callbacks)
        },
        detectExecutable: async () => executable,
        store: {
          read: () => profiles,
          write: async (next) => {
            profiles = next
          }
        }
      })
      registerAgentProfileHandlers(service)
      const invoke = async (name: string, input: unknown) =>
        handlers.get(`agentProfiles:${name}`)!(null, input)
      await expect(
        invoke('preview', { agent, source: { kind: 'managed', accountId: 'a' } })
      ).resolves.toMatchObject({ agent, resolvedHome: home, identity: { kind: 'verified' } })
      await expect(invoke('preview', { agent: '__proto__', source: {} })).rejects.toThrow(
        'Invalid profile connection'
      )
      await expect(invoke('save', { name: 3, connection: {} })).rejects.toThrow(
        'Invalid profile data'
      )
      await expect(invoke('unlink', {})).rejects.toThrow('Invalid profile reference')
      await invoke('save', {
        name: 'Original',
        connection: { agent, source: { kind: 'managed', accountId: 'a' } }
      })
      const saved = profiles[0]
      const rename = invoke('save', {
        id: saved.id,
        name: 'Renamed',
        connection: { agent, source: { kind: 'managed', accountId: 'a' } }
      })
      const acquisition = service.prepareById(saved.id, { mode: 'structured', resume: false })
      await rename
      const prepared = await acquisition
      expect(prepared.snapshot.name).toBe('Renamed')
      await invoke('unlink', saved.id)
      expect(profiles).toEqual([])
      expect(prepared.snapshot.name).toBe('Renamed')
      expect(prepareManaged).toHaveBeenCalledOnce()
      prepared.release()
    }
  )
})
