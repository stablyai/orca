import { describe, expect, it } from 'vitest'
import { applyCloudSessionEnv, cloudSessionEnvFromText } from './cloud-session-env'

const b64 = (value: string): string => Buffer.from(value).toString('base64')
const lay = (env: Record<string, string>, lines: string[] | null): Record<string, string> =>
  applyCloudSessionEnv(env, cloudSessionEnvFromText(env, lines === null ? null : lines.join('\n')))

describe('cloud session env overlay (RA-1)', () => {
  it('lays the live file over an env captured before a credential was added', () => {
    const env = lay({ PATH: '/usr/bin', ORCA_SESSION_ENV_NAMES: '' }, [
      `CLAUDE_CODE_OAUTH_TOKEN=${b64('orca-ph-claude-account-sbx_1')}`,
      `NPM_TOKEN=${b64('n')}`
    ])
    expect(env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'orca-ph-claude-account-sbx_1',
      NPM_TOKEN: 'n',
      ORCA_SESSION_ENV_NAMES: 'CLAUDE_CODE_OAUTH_TOKEN NPM_TOKEN'
    })
  })

  it('removes names an older session env set that the live one dropped (a revoked account)', () => {
    const started = {
      CLAUDE_CODE_OAUTH_TOKEN: 'orca-ph-claude-account-sbx_1',
      ORCA_SESSION_ENV_NAMES: 'CLAUDE_CODE_OAUTH_TOKEN'
    }
    expect(cloudSessionEnvFromText(started, '')?.unset).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    expect(lay(started, [])).toEqual({ ORCA_SESSION_ENV_NAMES: '' })
  })

  it('skips the names the shell hook skips', () => {
    const env = lay({ PATH: '/usr/bin' }, [
      `PATH=${b64('/evil')}`,
      `ORCA_X=${b64('x')}`,
      `LD_PRELOAD=${b64('x')}`,
      `bad-name=${b64('x')}`
    ])
    expect(env).toEqual({ PATH: '/usr/bin', ORCA_SESSION_ENV_NAMES: '' })
  })

  it('changes nothing before the file exists', () => {
    const env = { A: '1' }
    expect(lay(env, null)).toBe(env)
  })
})
