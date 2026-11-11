import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { scrubHermesAcpEnvironment } from './hermes-acp-environment'

describe('Hermes ACP environment', () => {
  it('starts Hermes with only the fixed list and the variables set for it', async () => {
    const inherited = {
      PATH: '/electron/bin',
      ORCA_RUNTIME_TOKEN: 'from-orca',
      AWS_SECRET_ACCESS_KEY: 'from-orca'
    }
    const { env, envToDelete } = await resolveAcpLaunchInvocation(
      acpLaunchSpecFor('hermes')!,
      { variable: 'HERMES_HOME', path: '/home/user/.hermes/profiles/orca' },
      {
        inheritedEnv: inherited,
        resolveEnvironment: async () => ({
          PATH: '/usr/bin',
          HOME: '/home/user',
          LC_TIME: 'C',
          GITHUB_TOKEN: 'from-shell',
          OPENROUTER_API_KEY: 'from-shell',
          HERMES_YOLO_MODE: '1'
        }),
        resolveLaunchEnv: () => ({ HTTPS_PROXY: 'http://proxy', HERMES_HOME: '/ignored' }),
        resolveCommand: (command) => `/resolved/${command}`,
        dataDirectory: '/orca-data'
      }
    )
    expect(resolveProviderChildEnv({ env, envToDelete }, inherited)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      LC_TIME: 'C',
      HTTPS_PROXY: 'http://proxy',
      HERMES_HOME: '/home/user/.hermes/profiles/orca'
    })
  })

  it('matches names without regard to case on Windows only', () => {
    const windows = { Path: 'C:\\bin', my_chosen: '1', Api_Key: 'secret' }
    expect(scrubHermesAcpEnvironment(windows, {}, ['MY_CHOSEN'], 'win32')).toEqual(['Api_Key'])
    expect(windows).toEqual({ Path: 'C:\\bin', my_chosen: '1' })

    const posix = { Path: '/bin', my_chosen: '1' }
    expect(scrubHermesAcpEnvironment(posix, {}, ['MY_CHOSEN'], 'linux')).toEqual([
      'Path',
      'my_chosen'
    ])
  })
})
