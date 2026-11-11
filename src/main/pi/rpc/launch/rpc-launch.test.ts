import { describe, expect, it } from 'vitest'

import { buildPiRpcLaunch } from './rpc-launch'

const options = { command: 'host-resolved-pi', cwd: '/host/folder', fullAccess: true }
describe('Pi RPC launch', () => {
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
})
