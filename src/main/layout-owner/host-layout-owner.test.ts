import path from 'node:path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import {
  createLayoutOwnerBanner,
  resolvesLayoutOwnerBeforeModules
} from '../../../config/build-plugins/layout-owner-banner'
import { createMainEntryPostBanner } from '../../../config/build-plugins/main-entry-post-banner'
import { MAIN_BUILD_ENTRY_POINTS } from '../../../config/build-plugins/main-build-entry-points'
import { resolveHostLayoutOwner, settleServerLayoutOwnerEnv } from './host-layout-owner'

type Env = Record<string, string | undefined>

function runBanner(input: { argv: string[]; env: Env; flag?: string }): Env {
  const env = { ...input.env }
  const fakeRequire = (id: string): unknown => {
    if (id === 'node:path') {
      return path
    }
    if (id === 'electron') {
      return { app: { isPackaged: true, getPath: () => '/user-data', getName: () => 'Orca' } }
    }
    if (id === 'node:fs') {
      return {
        readFileSync: () => {
          if (input.flag === undefined) {
            throw new Error('ENOENT')
          }
          return input.flag
        }
      }
    }
    throw new Error(`unexpected require ${id}`)
  }
  const fakeProcess = { env, argv: input.argv, platform: 'darwin' }
  new Function('require', 'process', 'globalThis', 'console', createLayoutOwnerBanner())(
    fakeRequire,
    fakeProcess,
    {},
    { warn: () => {} }
  )
  return env
}

describe('host layout owner', () => {
  it('resolves in the Electron banner exactly as orcad and the desktop resolver do', () => {
    const envs: Env[] = [
      {},
      { ORCA_LAYOUT_OWNER: 'main' },
      { ORCA_LAYOUT_OWNER: 'window' },
      { ORCA_LAYOUT_OWNER: 'bogus' },
      { ORCA_SERVER_LAYOUT_OWNER: 'main' },
      { ORCA_LAYOUT_OWNER: '', ORCA_SERVER_LAYOUT_OWNER: '' },
      { ORCA_LAYOUT_OWNER: 'main', ORCA_SERVER_LAYOUT_OWNER: 'window' },
      // A parent's resolved value is never this host's.
      { ORCA_LAYOUT_OWNER_RESOLVED: 'main' }
    ]
    for (const server of [false, true]) {
      for (const flag of [undefined, 'main\n', 'window', 'junk']) {
        for (const env of envs) {
          const expected = resolveHostLayoutOwner({ server, env, readFlag: () => flag }).owner
          const settled = runBanner({ argv: server ? ['orca', '--serve'] : ['orca'], env, flag })
          expect(settled.ORCA_LAYOUT_OWNER_RESOLVED, JSON.stringify({ server, flag, env })).toBe(
            expected
          )
          if (server) {
            const orcadEnv = { ...env }
            settleServerLayoutOwnerEnv(orcadEnv)
            expect(orcadEnv.ORCA_LAYOUT_OWNER_RESOLVED).toBe(expected)
            expect(orcadEnv.ORCA_LAYOUT_OWNER).toBeUndefined()
          }
        }
      }
    }
    // A desktop that turned the new path on never flips the server it starts.
    expect(
      runBanner({
        argv: ['orca', '--serve'],
        env: { ORCA_LAYOUT_OWNER: 'main', ORCA_LAYOUT_OWNER_RESOLVED: 'main' },
        flag: 'main'
      }).ORCA_LAYOUT_OWNER_RESOLVED
    ).toBe('window')
  })

  it('resolves before index.js loads any chunk that could hold the switch module', () => {
    const banner = createMainEntryPostBanner(
      { fileName: 'index.js', moduleIds: [MAIN_BUILD_ENTRY_POINTS.index] },
      () => ''
    )
    expect(resolvesLayoutOwnerBeforeModules(`${banner}require("./chunks/shared.js")`)).toBe(true)
    expect(resolvesLayoutOwnerBeforeModules(`require("./chunks/shared.js")\n${banner}`)).toBe(false)
  })

  it('settles in orcad before anything imports the switch module', () => {
    const claims = [
      '../memory/host-malloc-tunables-claim',
      '../ipc/pty/host-env/inherited-orca-identity-claim',
      './server-layout-owner-claim'
    ]
    for (const claim of claims) {
      const { metafile } = buildSync({
        entryPoints: [path.resolve(__dirname, `${claim}.ts`)],
        bundle: true,
        platform: 'node',
        packages: 'external',
        write: false,
        metafile: true,
        logLevel: 'silent'
      })
      expect(
        Object.keys(metafile.inputs).filter((input) => input.includes('layout-owner-switch'))
      ).toEqual([])
    }
  })
})
