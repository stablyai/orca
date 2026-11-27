import { afterEach, describe, expect, it } from 'vitest'
import { adoptCustomAcpAgents } from './custom-acp-launch-spec'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { resolveAcpLaunchCommand } from './acp-launch-command'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'

afterEach(() => adoptCustomAcpAgents([]))

describe('custom ACP agents', () => {
  it('launch exactly the saved command line, whatever else the settings hold', () => {
    adoptCustomAcpAgents([
      {
        id: 'desk',
        name: 'Desk',
        command: 'ssh',
        args: ['-T', 'dev-box', 'hq acp'],
        env: { A: '1' }
      },
      { id: 'desk', name: 'Second', command: 'other', args: [], env: {} },
      { id: 'Bad Id', name: 'Bad', command: 'x', args: [], env: {} },
      { id: 'empty', name: 'Empty', command: ' ', args: [], env: {} },
      'not an agent'
    ])
    const spec = acpLaunchSpecFor('custom-desk')
    expect(spec?.name).toBe('Desk')
    expect(spec?.args({ fullAccess: true, pluginDirs: ['/plugins'], model: 'm' })).toEqual([
      '-T',
      'dev-box',
      'hq acp'
    ])
    expect(spec?.env).toEqual({ A: '1' })
    expect(acpLaunchSpecFor('custom-empty')).toBeNull()
    expect(acpLaunchSpecFor('custom-Bad Id')).toBeNull()
    expect(structuredAgentRuntimeMetadata('custom-desk')?.definition.agent).toBe('custom-desk')
    const launch = resolveAcpLaunchCommand(
      spec!,
      { PATH: '/nowhere', HOME: '/home/u' },
      {
        commandSettings: { agentCmdOverrides: { kimi: 'evil' } },
        resolveCommand: (command) => `/usr/bin/${command}`,
        dataDirectory: null
      }
    )
    expect(launch).toEqual({ command: '/usr/bin/ssh', prefixArgs: [] })
  })

  it('register nothing once the list is gone', () => {
    adoptCustomAcpAgents([{ id: 'desk', name: 'Desk', command: 'ssh', args: [], env: {} }])
    adoptCustomAcpAgents(undefined)
    expect(acpLaunchSpecFor('custom-desk')).toBeNull()
    expect(structuredAgentRuntimeMetadata('custom-desk')).toBeNull()
  })
})
