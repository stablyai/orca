import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStatusPluginPostSource } from './status-plugin-post-source'
import { getStatusPluginRuntimeStateSource } from './status-plugin-runtime-state-source'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('generated shared-server capability without a test-only environment flag', () => {
  it.each([
    { argv: ['opencode', 'serve'], major: 0, capability: '1', expected: true },
    {
      argv: ['opencode', '/embedded/cli.js', '--log-level', 'none', 'serve'],
      major: 0,
      capability: '1',
      expected: true
    },
    {
      argv: ['opencode', '--log-level', 'serve', 'run', 'serve'],
      major: 0,
      capability: '1',
      expected: false
    },
    { argv: ['opencode', 'run', '--', 'serve'], major: 0, capability: '1', expected: false },
    { argv: ['opencode', '--', 'serve'], major: 0, capability: '1', expected: false },
    { argv: ['opencode', 'serve'], major: 2, capability: '1', expected: false },
    { argv: ['opencode', 'serve'], major: 0, capability: '', expected: false }
  ])(
    'recognizes only an opted-in legacy serve context: %j',
    async ({ argv, major, capability, expected }) => {
      vi.stubEnv('ORCA_PANE_KEY', 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', undefined)
      vi.spyOn(process, 'argv', 'get').mockReturnValue(argv)
      const posts: Record<string, unknown>[] = []
      vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
        posts.push(JSON.parse(String(init.body)))
        return new Response('{}', { status: 200 })
      })
      const source = [
        ...getStatusPluginRuntimeStateSource(),
        ...getStatusPluginPostSource('/hook/opencode'),
        `reportingOpenCodeMajor = ${major};`,
        'return post("SessionBusy", { sessionID: "ses_test" });'
      ].join('\n')
      const run = new Function('resolveHookCoords', source)
      await run(() => ({ port: 12345, token: 'fixture', openCodeTui: capability }))
      expect(posts).toHaveLength(1)
      expect(posts[0].opencodeSharedServer === 1).toBe(expected)
      expect(posts[0].opencodeMajor).toBe(major || undefined)
    }
  )
})
