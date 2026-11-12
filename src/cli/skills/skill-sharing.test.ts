import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { RuntimeRpcFailureError } from '../runtime/types'
import type { HandlerContext } from '../dispatch/dispatch'
import { SKILL_SHARING_HANDLERS } from './skill-sharing'

const successMeta = { runtimeId: 'runtime-1' }

function context(
  call: RuntimeClient['call'],
  flags = new Map<string, string | boolean>(),
  options: { isRemote?: boolean; json?: boolean } = {}
): HandlerContext {
  const client = new RuntimeClient('/tmp/orca-skill-sharing-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(options.isRemote ?? false)
  return {
    client,
    cwd: '/repo',
    flags,
    json: options.json ?? false
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('skill sharing CLI handlers', () => {
  it('lists safe installed-skill selectors without local paths', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: {
        skills: [
          {
            id: 'skill-id',
            name: 'alpha',
            description: 'Alpha skill',
            providers: ['codex'],
            sourceKind: 'home',
            sourceLabel: 'Codex',
            rootPath: '/secret/root',
            directoryPath: '/secret/root/alpha',
            skillFilePath: '/secret/root/alpha/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ],
        sources: [],
        scannedAt: 1
      },
      _meta: successMeta
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await SKILL_SHARING_HANDLERS['skills installed']!(context(call, new Map(), { json: true }))

    expect(call).toHaveBeenCalledWith('skills.discover', { cwd: '/repo' })
    const output = String(log.mock.calls[0][0])
    expect(output).toContain('skill-id')
    expect(output).not.toContain('/secret/root')
  })

  it('denies publishing at preflight before invoking skills.share', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { settings: { agentSkillSharingEnabled: false } },
      _meta: successMeta
    })

    await expect(
      SKILL_SHARING_HANDLERS['skills share']!(
        context(
          call,
          new Map([
            ['skill', 'alpha'],
            ['bundle-name', 'team-skills']
          ])
        )
      )
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_disabled' })
    expect(call).toHaveBeenCalledExactlyOnceWith('settings.get')
  })

  it('rejects a bundle name that cannot produce a valid package name', async () => {
    const call = vi.fn()

    await expect(
      SKILL_SHARING_HANDLERS['skills share']!(
        context(
          call,
          new Map([
            ['skill', 'alpha'],
            ['bundle-name', '🔥']
          ])
        )
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--bundle-name must contain at least one English letter or number.'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['a forwarded shell', false, '/remote/repo'],
    ['a paired runtime', true, undefined]
  ])('rejects %s before any discovery or publish call', async (_label, isRemote, forwardedCwd) => {
    if (forwardedCwd) {
      vi.stubEnv('ORCA_CLI_CWD', forwardedCwd)
    }
    const call = vi.fn()

    await expect(
      SKILL_SHARING_HANDLERS['skills share']!(
        context(
          call,
          new Map([
            ['skill', 'alpha'],
            ['bundle-name', 'alpha']
          ]),
          { isRemote }
        )
      )
    ).rejects.toMatchObject({ code: 'invalid_environment' })
    expect(call).not.toHaveBeenCalled()
  })

  it('gives an actionable upgrade error for an older runtime', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'settings',
        ok: true,
        result: { settings: {} },
        _meta: successMeta
      })
      .mockRejectedValueOnce(
        new RuntimeRpcFailureError({
          id: 'share',
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: successMeta
        })
      )

    await expect(
      SKILL_SHARING_HANDLERS['skills share']!(
        context(
          call,
          new Map([
            ['skill', 'alpha'],
            ['bundle-name', 'alpha']
          ])
        )
      )
    ).rejects.toMatchObject({ code: 'update_required' })
  })
})
