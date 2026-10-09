import { describe, expect, it } from 'vitest'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { buildPiRpcLaunch } from './rpc-launch'

const options = { command: 'host-resolved-pi', cwd: '/host/folder', fullAccess: true }
describe('Pi RPC launch', () => {
  it('uses the supplied host binary and folder, and lets Pi choose its own session store', () => {
    expect(buildPiRpcLaunch(options)).toMatchObject({
      command: options.command,
      cwd: options.cwd,
      args: ['--mode', 'rpc']
    })
  })

  it.each([
    '/host/.pi/agent/sessions/session.jsonl',
    'C:\\Users\\dev\\.pi\\agent\\sessions\\session.jsonl'
  ])('passes the native session file unchanged: %s', (sessionFile) => {
    expect(buildPiRpcLaunch({ ...options, sessionFile }).args).toEqual([
      '--mode',
      'rpc',
      '--session',
      sessionFile
    ])
  })

  it('retains selected account and user extension args, but strips inherited pane hook identities after overlays', () => {
    const launch = buildPiRpcLaunch({
      ...options,
      extraArgs: ['--extension', '/host/my extension.ts'],
      env: {
        PI_CODING_AGENT_DIR: '/host/account',
        ORCA_PANE_KEY: 'other-pane',
        ORCA_AGENT_PANE: 'alias'
      }
    })
    const env = resolveProviderChildEnv(launch, {
      ORCA_AGENT_HOOK_TOKEN: 'inherited',
      API_KEY: 'retained'
    })
    expect(env).toEqual({ API_KEY: 'retained', PI_CODING_AGENT_DIR: '/host/account' })
    expect(launch.args).toEqual(['--mode', 'rpc', '--extension', '/host/my extension.ts'])
  })

  it.each([
    ['--provider', 'anthropic', '--model', 'model-id'],
    ['--provider=anthropic', '--model=model-id'],
    ['--provider=anthropic', '-m', 'model-id'],
    ['--model', 'anthropic/model-id']
  ])('accepts paired model/provider selections: %j', (...extraArgs) => {
    expect(buildPiRpcLaunch({ ...options, extraArgs }).args).toEqual([
      '--mode',
      'rpc',
      ...extraArgs
    ])
  })

  it.each([['--provider', 'anthropic'], ['--provider=anthropic'], ['--model'], ['--model=']])(
    'rejects incomplete provider/model args: %j',
    (...extraArgs) => {
      expect(() => buildPiRpcLaunch({ ...options, extraArgs })).toThrow(/requires/)
    }
  )

  it.each([
    '--mode=json',
    '--print',
    '-p',
    '--no-session',
    '--session=other',
    '--resume',
    '--continue'
  ])('rejects arguments that bypass the chat mode or its session handle: %s', (arg) => {
    expect(() => buildPiRpcLaunch({ ...options, extraArgs: [arg] })).toThrow('conflicts')
  })

  it('rejects a supervised permissions request instead of silently running in full access', () => {
    expect(() => buildPiRpcLaunch({ ...options, fullAccess: false })).toThrow('full access only')
  })

  it('rejects an empty supplied resume handle', () => {
    expect(() => buildPiRpcLaunch({ ...options, sessionFile: '' })).toThrow(
      'requires a session file'
    )
  })

  it('scrubs inherited structured identity and injects only this acquisition identity', () => {
    const inherited = {
      ORCA_AGENT_SESSION_ID: 'stale',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_TERMINAL_HANDLE: 'structworker_stale',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'old-token'
    }
    expect(resolveProviderChildEnv(buildPiRpcLaunch(options), inherited)).toEqual({})
    const childEnv = resolveProviderChildEnv(
      buildPiRpcLaunch({
        ...options,
        env: inherited,
        structuredSession: { id: 'this-session', spawnToken: 'this-token' }
      }),
      inherited
    )
    expect(childEnv).toMatchObject({
      ORCA_AGENT_SESSION_ID: 'this-session',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'this-token'
    })
    expect(childEnv).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
  })
})
