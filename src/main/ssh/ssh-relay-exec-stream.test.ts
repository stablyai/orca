import { describe, expect, it } from 'vitest'
import { buildRemoteProcessCommand } from './ssh-relay-exec-stream'

describe('buildRemoteProcessCommand', () => {
  it('builds an exec line with shell-escaped command and args', () => {
    const command = buildRemoteProcessCommand({
      command: '/usr/bin/node',
      args: ['--inspect', 'server.js']
    })
    expect(command).toBe("exec '/usr/bin/node' '--inspect' 'server.js'")
  })

  it('shell-escapes args containing spaces and single quotes', () => {
    const command = buildRemoteProcessCommand({
      command: 'node',
      args: ["it's a test", 'has space']
    })
    expect(command).toBe("exec 'node' 'it'\\''s a test' 'has space'")
  })

  it('prefixes env vars before the exec line', () => {
    const command = buildRemoteProcessCommand({
      command: 'node',
      args: ['server.js'],
      env: { NODE_ENV: 'production', DEBUG: 'true' }
    })
    expect(command).toBe("NODE_ENV='production' DEBUG='true' exec 'node' 'server.js'")
  })

  it('prepends a cd into cwd, shell-escaped, when cwd is given', () => {
    const command = buildRemoteProcessCommand({
      command: 'node',
      args: ['server.js'],
      cwd: '/home/user/my project'
    })
    expect(command).toBe("cd '/home/user/my project' && exec 'node' 'server.js'")
  })

  it('combines cwd and env with the exec line', () => {
    const command = buildRemoteProcessCommand({
      command: 'node',
      args: [],
      cwd: '/srv/app',
      env: { PORT: '3000' }
    })
    expect(command).toBe("cd '/srv/app' && PORT='3000' exec 'node'")
  })
})
