import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { RuntimeClient, RuntimeRpcFailureError } from '../runtime-client'
import type { HandlerContext } from '../dispatch'
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

  it('publishes multiple explicit skills and prints only public output', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'settings',
        ok: true,
        result: { settings: { agentSkillSharingEnabled: true } },
        _meta: successMeta
      })
      .mockResolvedValueOnce({
        id: 'share',
        ok: true,
        result: {
          status: 'ok',
          value: {
            share: { id: 'shr_public', url: 'https://share.onorca.dev/skills/share/shr_public' },
            version: {
              packageId: 'pkg_public',
              versionId: 'ver_public',
              name: 'team-skills'
            },
            selectedSkills: [
              { id: 'alpha-id', name: 'alpha', description: null },
              { id: 'beta-id', name: 'beta', description: null }
            ]
          }
        },
        _meta: successMeta
      })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await SKILL_SHARING_HANDLERS['skills share']!(
      context(
        call,
        new Map([
          ['skill', `alpha${REPEATED_FLAG_SEPARATOR}beta`],
          ['bundle-name', 'team-skills'],
          ['release-notes', 'Initial bundle']
        ]),
        { json: true }
      )
    )

    expect(call).toHaveBeenLastCalledWith(
      'skills.share',
      {
        skillSelectors: ['alpha', 'beta'],
        bundleName: 'team-skills',
        releaseNotes: 'Initial bundle',
        target: { cwd: '/repo' }
      },
      { timeoutMs: 600_000 }
    )
    const output = String(log.mock.calls[0][0])
    expect(JSON.parse(output).result).toEqual({
      url: 'https://share.onorca.dev/skills/share/shr_public',
      shareId: 'shr_public',
      packageId: 'pkg_public',
      versionId: 'ver_public',
      bundleName: 'team-skills',
      skills: [
        { id: 'alpha-id', name: 'alpha', description: null },
        { id: 'beta-id', name: 'beta', description: null }
      ]
    })
  })

  it('normalizes a human-readable bundle name before publishing', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'settings',
        ok: true,
        result: { settings: { agentSkillSharingEnabled: true } },
        _meta: successMeta
      })
      .mockResolvedValueOnce({
        id: 'share',
        ok: true,
        result: {
          status: 'ok',
          value: {
            share: { id: 'shr_public', url: 'https://share.onorca.dev/skills/share/shr_public' },
            version: {
              packageId: 'pkg_public',
              versionId: 'ver_public',
              name: 'team-skills-v2.0'
            },
            selectedSkills: [{ id: 'alpha-id', name: 'alpha', description: null }]
          }
        },
        _meta: successMeta
      })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await SKILL_SHARING_HANDLERS['skills share']!(
      context(
        call,
        new Map([
          ['skill', 'alpha'],
          ['bundle-name', 'Téam Skills -- v2.0']
        ])
      )
    )

    expect(call).toHaveBeenLastCalledWith(
      'skills.share',
      {
        skillSelectors: ['alpha'],
        bundleName: 'team-skills-v2.0',
        releaseNotes: '',
        target: { cwd: '/repo' }
      },
      { timeoutMs: 600_000 }
    )
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
