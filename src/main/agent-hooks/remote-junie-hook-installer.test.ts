import { describe, expect, it } from 'vitest'
import { JunieHookService } from '../junie/hook-service'
import { createFakeSftp } from './fake-sftp.test-fixtures'

describe('remote Junie hook installer', () => {
  it('installs remote Junie hooks into ~/.junie/config.json preserving user config', async () => {
    const userConfig = '{\n  "model": "gpt-5",\n  "effort": "high"\n}\n'
    const { sftp, fs } = createFakeSftp({ '/home/dev/.junie/config.json': userConfig })

    const status = await new JunieHookService().installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')

    const config = JSON.parse(fs.files.get('/home/dev/.junie/config.json')!)
    expect(config.model).toBe('gpt-5')
    expect(config.effort).toBe('high')
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'Stop',
      'StopFailure',
      'SessionEnd'
    ]) {
      expect(config.hooks[eventName][0].hooks[0].command).toContain(
        '/home/dev/.orca/agent-hooks/junie-hook.sh'
      )
    }
    // Junie's matcher is a regex and omitted means "all"; Claude's "*" would not match.
    expect(config.hooks.PreToolUse[0].matcher).toBeUndefined()
    expect(fs.files.get('/home/dev/.orca/agent-hooks/junie-hook.sh')).toContain('/hook/junie')
  })
})
