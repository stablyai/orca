import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import { KiroHookService } from './hook-service'
import { KIRO_HOOK_EVENTS } from './hook-settings'

describe('KiroHookService.installRemote', () => {
  it('writes the Orca-owned hooks file pointing at the POSIX script, even from a Windows host', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { sftp, fs } = createAgentHookMemorySftp()

      const status = await new KiroHookService().installRemote(sftp, '/home/dev/')
      expect(status).toMatchObject({
        agent: 'kiro',
        state: 'installed',
        configPath: '/home/dev/.kiro/hooks/orca-agent-status.json'
      })

      const file = JSON.parse(fs.files.get('/home/dev/.kiro/hooks/orca-agent-status.json') ?? '')
      expect(file.version).toBe('v1')
      expect(file.hooks.map((entry: { trigger: string }) => entry.trigger)).toEqual([
        ...KIRO_HOOK_EVENTS
      ])
      for (const entry of file.hooks) {
        expect(entry.action.command).toContain('/home/dev/.orca/agent-hooks/kiro-hook.sh')
      }
      const script = fs.files.get('/home/dev/.orca/agent-hooks/kiro-hook.sh') ?? ''
      expect(script.startsWith('#!/bin/sh')).toBe(true)
      expect(script).toContain('/hook/kiro')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('refuses to overwrite a remote same-named file that holds hooks Orca did not write', async () => {
    const userFile = JSON.stringify({
      version: 'v1',
      hooks: [{ name: 'mine', trigger: 'Stop', action: { type: 'command', command: 'notify.sh' } }]
    })
    const { sftp, fs } = createAgentHookMemorySftp({
      '/home/dev/.kiro/hooks/orca-agent-status.json': userFile
    })

    const status = await new KiroHookService().installRemote(sftp, '/home/dev')
    expect(status).toMatchObject({ agent: 'kiro', state: 'error' })
    expect(fs.files.get('/home/dev/.kiro/hooks/orca-agent-status.json')).toBe(userFile)
  })
})
