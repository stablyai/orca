import { describe, expect, it } from 'vitest'
import { cloudSessionEnv, withCloudSessionEnv } from './cloud-session-env'

const CLOUD = { ORCA_IS_CLOUD: '1', ORCA_SANDBOX_ID: 'sbx_1' }
const b64 = (value: string): string => Buffer.from(value).toString('base64')
const file =
  (lines: string[]) =>
  (path: string): string => {
    expect(path).toBe('/dev/shm/orca-env-1000/session.env')
    return lines.join('\n')
  }

describe('cloud session env overlay (RA-1)', () => {
  it('lays the live file over an env captured before a credential was added', () => {
    const started = { PATH: '/usr/bin', ORCA_SESSION_ENV_NAMES: '' }
    const env = withCloudSessionEnv(started, {
      processEnv: CLOUD,
      uid: 1000,
      read: file([
        `CLAUDE_CODE_OAUTH_TOKEN=${b64('orca-ph-claude-account-sbx_1')}`,
        `NPM_TOKEN=${b64('n')}`
      ])
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('orca-ph-claude-account-sbx_1')
    expect(env.NPM_TOKEN).toBe('n')
    expect(env.ORCA_SESSION_ENV_NAMES).toBe('CLAUDE_CODE_OAUTH_TOKEN NPM_TOKEN')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('removes names an older session env set that the live one dropped (a revoked account)', () => {
    const started = {
      CLAUDE_CODE_OAUTH_TOKEN: 'orca-ph-claude-account-sbx_1',
      ORCA_SESSION_ENV_NAMES: 'CLAUDE_CODE_OAUTH_TOKEN'
    }
    const current = cloudSessionEnv(started, { processEnv: CLOUD, uid: 1000, read: file([]) })
    expect(current?.unset).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    expect(withCloudSessionEnv(started, { processEnv: CLOUD, uid: 1000, read: file([]) })).toEqual({
      ORCA_SESSION_ENV_NAMES: ''
    })
  })

  it('skips the names the shell hook skips', () => {
    const env = withCloudSessionEnv(
      { PATH: '/usr/bin' },
      {
        processEnv: CLOUD,
        uid: 1000,
        read: file([
          `PATH=${b64('/evil')}`,
          `ORCA_X=${b64('x')}`,
          `LD_PRELOAD=${b64('x')}`,
          `bad-name=${b64('x')}`
        ])
      }
    )
    expect(env).toEqual({ PATH: '/usr/bin', ORCA_SESSION_ENV_NAMES: '' })
  })

  it('changes nothing off the cloud or before the file exists', () => {
    const env = { A: '1' }
    expect(withCloudSessionEnv(env, { processEnv: {}, uid: 1000, read: file([]) })).toBe(env)
    const missing = (): string => {
      throw new Error('ENOENT')
    }
    expect(withCloudSessionEnv(env, { processEnv: CLOUD, uid: 1000, read: missing })).toBe(env)
  })
})
