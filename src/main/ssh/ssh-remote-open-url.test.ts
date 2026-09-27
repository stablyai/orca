import { describe, expect, it, vi } from 'vitest'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { runRemoteOpenUrl } from './ssh-remote-open-url'
import { BrowserError } from '../browser/browser-error'

const authority = {
  kind: 'ssh' as const,
  targetId: 'ssh-build-box',
  connectionIncarnation: 'c1',
  attachmentId: 'a1'
}

function run(
  argv: string[],
  outcome: 'sent' | 'no_desktop' | 'rate_limited' = 'sent',
  withAuthority = true
) {
  const runtime = { requestDesktopOpenUrlForSshTarget: vi.fn((): typeof outcome => outcome) }
  const result = runRemoteOpenUrl(
    runtime,
    {
      argv,
      cwd: '/home/me/demo-repo',
      env: {},
      ...(withAuthority ? { runtimeAuthority: authority } : {})
    },
    parseRemoteCliArgs(argv)
  )
  return { result, runtime }
}

describe('runRemoteOpenUrl', () => {
  it('asks the desktop for the calling SSH target, ignoring a worktree the host supplies', () => {
    const { result, runtime } = run([
      'open-url',
      '--url',
      'https://phish.example/',
      '--worktree',
      'id:trusted-repo::/home/me/trusted'
    ])
    expect(result.exitCode).toBe(0)
    expect(runtime.requestDesktopOpenUrlForSshTarget).toHaveBeenCalledWith({
      url: 'https://phish.example/',
      sshTargetId: 'ssh-build-box'
    })
  })

  it('reports rate limiting and a missing desktop as failures', () => {
    expect(run(['open-url', '--url', 'https://a.example/'], 'rate_limited').result.exitCode).toBe(1)
    expect(run(['open-url', '--url', 'https://a.example/'], 'no_desktop').result.exitCode).toBe(1)
  })

  it('refuses without a URL or without a desktop attachment', () => {
    expect(run(['open-url']).result.exitCode).toBe(2)
    const unattached = run(['open-url', '--url', 'https://a.example/'], 'sent', false)
    expect(unattached.result.exitCode).toBe(1)
    expect(unattached.runtime.requestDesktopOpenUrlForSshTarget).not.toHaveBeenCalled()
  })

  it('reports a refused URL scheme, but shows any other failure as it is', () => {
    const argv = ['open-url', '--url', 'https://a.example/']
    const parsed = parseRemoteCliArgs(argv)
    const request = { argv, cwd: '/', env: {}, runtimeAuthority: authority }
    const refusing = {
      requestDesktopOpenUrlForSshTarget: vi.fn((): 'sent' => {
        throw new BrowserError('invalid_argument', 'Only http(s) URLs can be opened on the client.')
      })
    }
    const broken = {
      requestDesktopOpenUrlForSshTarget: vi.fn((): 'sent' => {
        throw new TypeError('runtime is not ready')
      })
    }
    expect(runRemoteOpenUrl(refusing, request, parsed)).toMatchObject({
      stderr: 'orca open-url: only http(s) URLs can be opened\n',
      exitCode: 2
    })
    expect(runRemoteOpenUrl(broken, request, parsed)).toMatchObject({
      stderr: 'orca open-url: runtime is not ready\n',
      exitCode: 1
    })
  })
})
