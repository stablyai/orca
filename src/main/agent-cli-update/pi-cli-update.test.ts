import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkAgentCliUpdates, runAgentCliUpdate } from './agent-cli-update-service'

const { launchEnvironment } = vi.hoisted(() => ({ launchEnvironment: vi.fn() }))
vi.mock('../runtime/agent-session/launch/structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: launchEnvironment
}))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: async (url: string) => {
      if (url === 'https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest') {
        return Response.json({ version: '1.7.0' })
      }
      if (url.endsWith('/agent-cli-model-requirements.json')) {
        return Response.json({ models: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }
  })
}))

it.skipIf(process.platform === 'win32')(
  'tracks Pi releases behind an unchanged launcher',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-pi-update-'))
    try {
      const agent = join(home, '.pi', 'agent')
      const bin = join(agent, 'bin')
      const install = join(agent, 'install')
      const current = join(install, 'current-version')
      await mkdir(bin, { recursive: true })
      await mkdir(install)
      await writeFile(current, '1.5.0\n')
      await writeFile(
        join(bin, 'pi'),
        [
          '#!/bin/sh',
          'current="${0%/*}/../install/current-version"',
          'case "$*" in',
          '  --version) read -r version < "$current" && printf "%s\\n" "$version" ;;',
          '  "update --self") printf "1.7.0\\n" > "$current" ;;',
          '  *) exit 1 ;;',
          'esac'
        ].join('\n'),
        { mode: 0o755 }
      )
      launchEnvironment.mockResolvedValue({ PATH: bin, HOME: home })

      vi.useFakeTimers({ toFake: ['Date'] })
      expect(await checkAgentCliUpdates({}, ['pi'])).toEqual([
        {
          agent: 'pi',
          installedVersion: '1.5.0',
          latestVersion: '1.7.0',
          runnable: true,
          command: 'pi update --self'
        }
      ])

      await writeFile(current, '1.6.0\n')
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await checkAgentCliUpdates({}, ['pi'])).toMatchObject([{ installedVersion: '1.6.0' }])

      expect(await runAgentCliUpdate('pi', {})).toEqual({ ok: true })
      expect(await checkAgentCliUpdates({}, ['pi'])).toEqual([])
    } finally {
      vi.useRealTimers()
      await rm(home, { recursive: true, force: true })
    }
  }
)
