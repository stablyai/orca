import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import { KiroHookService } from './hook-service'
import { KIRO_STANDALONE_HOOK_TRIGGERS } from './standalone-hook-settings'

const REMOTE_HOOKS_FILE = '/home/dev/.kiro/hooks/orca-agent-status.json'

afterEach(() => vi.restoreAllMocks())

describe('KiroHookService.installRemote with the V3 standalone hooks file', () => {
  it('writes the V3 file pointing at the POSIX script with no custom agent, even from Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { sftp, fs } = createAgentHookMemorySftp()

    const status = await new KiroHookService().installRemote(sftp, '/home/dev/')
    // The default-engine status stays primary; only a V3 error would surface in it.
    expect(status).toMatchObject({ agent: 'kiro', state: 'not_installed' })
    expect(status.detail).not.toContain(REMOTE_HOOKS_FILE)

    const file = JSON.parse(fs.files.get(REMOTE_HOOKS_FILE) ?? '')
    expect(file.version).toBe('v1')
    expect(file.hooks.map((entry: { trigger: string }) => entry.trigger)).toEqual([
      ...KIRO_STANDALONE_HOOK_TRIGGERS
    ])
    for (const entry of file.hooks) {
      expect(entry.action.command).toContain('/home/dev/.orca/agent-hooks/kiro-hook.sh')
    }
    const script = fs.files.get('/home/dev/.orca/agent-hooks/kiro-hook.sh') ?? ''
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('/hook/kiro')
  })

  it('keeps the V3 file under the remote home when a KIRO_HOME was probed', async () => {
    const { sftp, fs } = createAgentHookMemorySftp()

    await new KiroHookService().installRemote(sftp, '/home/dev', '/opt/kiro')
    expect(fs.files.has(REMOTE_HOOKS_FILE)).toBe(true)
    expect(fs.files.has('/opt/kiro/hooks/orca-agent-status.json')).toBe(false)
  })

  it('refuses to overwrite a remote same-named file that holds hooks Orca did not write', async () => {
    const userFile = JSON.stringify({
      version: 'v1',
      hooks: [{ name: 'mine', trigger: 'Stop', action: { type: 'command', command: 'notify.sh' } }]
    })
    const { sftp, fs } = createAgentHookMemorySftp({ [REMOTE_HOOKS_FILE]: userFile })

    const status = await new KiroHookService().installRemote(sftp, '/home/dev')
    expect(status.detail).toContain(`${REMOTE_HOOKS_FILE}: Left the Kiro hooks file`)
    expect(fs.files.get(REMOTE_HOOKS_FILE)).toBe(userFile)
  })
})
