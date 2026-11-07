import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeRpcFailureError } from '../runtime/types'
import { classifyPluginInstallSource, PLUGIN_INSTALL_HANDLERS } from './plugin-install'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function context(
  flags: Record<string, string | boolean>,
  options: { cwd?: string; rawArgs?: string[]; call?: ReturnType<typeof vi.fn> } = {}
): HandlerContext {
  const client = { isRemote: false, call: options.call ?? vi.fn() }
  return {
    flags: new Map(Object.entries(flags)),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers here only read isRemote and call.
    client: client as unknown as RuntimeClient,
    cwd: options.cwd ?? '/work',
    json: true,
    rawArgs: options.rawArgs ?? []
  }
}

describe('classifyPluginInstallSource', () => {
  it('reads a catalog id, owner/repo@ref, --ref and URLs', () => {
    expect(classifyPluginInstallSource(context({}), 'acme.dusk')).toEqual({
      kind: 'catalog',
      pluginKey: 'acme.dusk'
    })
    expect(classifyPluginInstallSource(context({ catalog: 'community' }), 'acme.dusk')).toEqual({
      kind: 'catalog',
      pluginKey: 'acme.dusk',
      catalog: 'community'
    })
    expect(classifyPluginInstallSource(context({}), 'acme/notes@v1.2.0')).toEqual({
      kind: 'git',
      input: 'acme/notes#v1.2.0'
    })
    expect(classifyPluginInstallSource(context({ ref: 'main' }), 'acme/notes')).toEqual({
      kind: 'git',
      input: 'acme/notes#main'
    })
    expect(
      classifyPluginInstallSource(context({}), 'git@github.com:acme/private-notes.git')
    ).toEqual({ kind: 'git', input: 'git@github.com:acme/private-notes.git' })
  })

  it('treats paths and folders with a manifest as folders on the Orca host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-install-cli-'))
    roots.push(root)
    await writeFile(join(root, 'orca-plugin.json'), '{}')
    expect(classifyPluginInstallSource(context({}, { cwd: '/work' }), './dusk')).toEqual({
      kind: 'local-path',
      path: resolve('/work', 'dusk')
    })
    expect(classifyPluginInstallSource(context({}, { cwd: root }), '.')).toEqual({
      kind: 'local-path',
      path: root
    })
  })

  it('refuses a version given twice or --catalog on a Git source', () => {
    expect(() => classifyPluginInstallSource(context({ ref: 'v2' }), 'acme/notes@v1')).toThrow(
      'Pass the version once'
    )
    expect(() => classifyPluginInstallSource(context({ catalog: 'x' }), 'acme/notes')).toThrow(
      '--catalog only applies'
    )
  })
})

describe('plugin update --all approvals', () => {
  it('turns each pending approval into the same command for that plugin', async () => {
    const call = vi.fn().mockRejectedValue(
      new RuntimeRpcFailureError({
        id: '1',
        ok: false,
        error: {
          code: 'approval_required',
          message: '1 plugin update(s) need approval',
          data: {
            approvals: [{ pluginKey: 'acme.notes', approvalFingerprint: 'ap1-abc' }],
            nextSteps: [
              'Confirm with your user first.',
              'To approve acme.notes, run: orca plugin update acme.notes --approve ap1-abc'
            ]
          }
        },
        _meta: { runtimeId: null }
      })
    )
    const ctx = context(
      { all: true },
      { call, rawArgs: ['plugin', 'update', '--all', '--environment', 'build-box', '--json'] }
    )

    const error = await PLUGIN_INSTALL_HANDLERS['plugin update'](ctx).catch((cause) => cause)

    expect(error).toMatchObject({
      code: 'approval_required',
      data: {
        nextSteps: [
          'Confirm with your user first.',
          'To approve acme.notes, run: orca plugin update acme.notes --environment build-box --json --approve ap1-abc'
        ]
      }
    })
  })
})
