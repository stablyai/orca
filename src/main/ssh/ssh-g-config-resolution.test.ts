import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, homedirMock, userInfoMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(() => true),
  homedirMock: vi.fn<() => string>(() => '/home/env'),
  userInfoMock: vi.fn<() => { homedir: string }>(() => ({ homedir: '/home/env' }))
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:os', () => ({ homedir: homedirMock, userInfo: userInfoMock }))

import { sshGArgsForHost } from './ssh-g-config-resolution'

describe('sshGArgsForHost', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(true)
    homedirMock.mockReset().mockReturnValue('/home/env')
    userInfoMock.mockReset().mockReturnValue({ homedir: '/home/env' })
  })

  it('keeps OpenSSH default resolution when HOME matches the passwd home', () => {
    // Why: the default search still reads /etc/ssh/ssh_config, which the
    // SshResolvedConfig.gssapiAuthentication contract depends on.
    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('pins the HOME config when it diverges from the passwd home', () => {
    homedirMock.mockReturnValue('/tmp/e2e-home')

    expect(sshGArgsForHost('prod')).toEqual(['-F', '/tmp/e2e-home/.ssh/config', '-G', '--', 'prod'])
    expect(existsSyncMock).toHaveBeenCalledWith('/tmp/e2e-home/.ssh/config')
  })

  it('falls back to passwd-home resolution when the HOME config is absent', () => {
    // Why: ssh exits 255 on a missing -F file, so a divergent HOME without a
    // config must not pin one. The picker lists nothing here, so the wider
    // passwd-home resolution never mints a target.
    homedirMock.mockReturnValue('/tmp/e2e-home')
    existsSyncMock.mockReturnValue(false)

    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('treats an unavailable passwd entry as a HOME match', () => {
    userInfoMock.mockImplementation(() => {
      throw new Error('getpwuid failed')
    })

    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('does not let a leading-dash alias become a flag', () => {
    homedirMock.mockReturnValue('/tmp/e2e-home')

    expect(sshGArgsForHost('-oProxyCommand=touch /tmp/pwned')).toEqual([
      '-F',
      '/tmp/e2e-home/.ssh/config',
      '-G',
      '--',
      '-oProxyCommand=touch /tmp/pwned'
    ])
  })
})
