import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as RunProcess from '../../shared/child-process/run-process'
import { runProcessSync } from '../../shared/child-process/run-process'
import { buildConfiguredProxyEnv } from '../../shared/network-proxy'
import { quoteHiddenRateLimitShellValue } from './hidden-rate-limit-shell'

const { spawn, readRpc } = vi.hoisted(() => ({ spawn: vi.fn(), readRpc: vi.fn() }))

vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcess>()),
  spawnProcess: spawn
}))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: () => 'present' }))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: () => false }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))
vi.mock('./codex-rpc-rate-limit-probe', () => ({ readCodexRateLimitsViaRpc: readRpc }))
vi.mock('./codex-backend-usage-client', () => ({
  fetchCodexRateLimitsViaBackend: async () => null,
  supplementCodexSessionWindow: async (limits: unknown) => limits
}))
vi.mock('./codex-reset-credit-client', () => ({
  consumeCodexRateLimitResetCreditFromBackend: vi.fn(),
  supplementCodexRateLimitResetCredits: async (limits: unknown) => limits
}))

import { fetchCodexRateLimits } from './codex-fetcher'

describe('Codex WSL probe proxy environment', () => {
  const platform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it.each(['localhost;*.fixture.invalid', ''])(
    'exports validated proxy and bypass %j inside the guest command',
    async (bypassRules) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('CODEX_HOME', 'C:\\host-only-home')
      vi.stubEnv('NO_PROXY', 'inherited.invalid')
      vi.stubEnv('WSLENV', 'KEEP/p:LANG/u')
      readRpc.mockResolvedValue({
        provider: 'codex',
        session: null,
        weekly: null,
        status: 'ok',
        updatedAt: 1
      })
      const networkProxySettings = {
        httpProxyUrl: "http://fixture:pass'word$@proxy.fixture.invalid:8080",
        httpProxyBypassRules: bypassRules
      }

      await fetchCodexRateLimits({
        codexHomePath: '\\\\wsl.localhost\\FixtureDistro\\home\\fixture\\.codex',
        networkProxySettings
      })

      const spec = spawn.mock.calls[0]?.[0]
      expect(spec.program).toBe('wsl.exe')
      expect(spec.args.slice(0, 5)).toEqual(['-d', 'FixtureDistro', '--exec', 'sh', '-c'])
      expect(spec.env.CODEX_HOME).toBeUndefined()
      const shellCommand = spec.args.at(-1)
      expect(shellCommand).not.toContain('proxy.fixture.invalid')
      expect(shellCommand).not.toContain('word$')
      expect(spec.env.WSLENV.split(':')).toEqual(expect.arrayContaining(['KEEP/p', 'LANG/u']))
      const entries = Object.entries(buildConfiguredProxyEnv(networkProxySettings))
      const aliases = spec.env.WSLENV.split(':').filter((key: string) =>
        key.startsWith('ORCA_CODEX_USAGE_ENV_')
      )
      expect(new Set(aliases.map((key: string) => key.toUpperCase())).size).toBe(entries.length)
      for (const [index, [key, value]] of entries.entries()) {
        expect(spec.env[key]).toBe(value)
        expect(spec.env[`ORCA_CODEX_USAGE_ENV_${index}`]).toBe(value)
        expect(spec.env.WSLENV.split(':')).toContain(`ORCA_CODEX_USAGE_ENV_${index}`)
        expect(shellCommand).toContain(`export ${key}="$ORCA_CODEX_USAGE_ENV_${index}"`)
      }
      expect(shellCommand).toContain('export CODEX_HOME=')
      expect(shellCommand).toContain('exec codex ')
      expect(shellCommand).toContain('<&3 >&4 3<&- 4>&-')
      expect(process.env.CODEX_HOME).toBe('C:\\host-only-home')
      expect(process.env.NO_PROXY).toBe('inherited.invalid')
    }
  )

  it.skipIf(platform === 'win32').each(["localhost;literal'quote;$(printf unsafe)", ''])(
    'runs the emitted POSIX command with login overrides and bypass %j',
    async (bypassRules) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-proxy-'))
      try {
        const bin = join(root, 'bin')
        mkdirSync(bin)
        const guestShell = join(bin, 'sh')
        writeFileSync(
          guestShell,
          '#!/bin/sh\nexport HTTP_PROXY=login-profile HTTPS_PROXY=login-profile ALL_PROXY=login-profile\nexport http_proxy=login-profile https_proxy=login-profile all_proxy=login-profile\nexport NO_PROXY=login-profile no_proxy=login-profile\nexec /bin/sh -c "$2"\n',
          { mode: 0o700 }
        )
        writeFileSync(
          join(bin, 'getent'),
          `#!/bin/sh\nprintf '%s\\n' ${quoteHiddenRateLimitShellValue(`fixture:x:1:1::/unused:${guestShell}`)}\n`,
          { mode: 0o700 }
        )
        const probe = join(root, 'probe.cjs')
        writeFileSync(
          probe,
          `process.stdout.write(JSON.stringify({ proxy: Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy'].map(key => [key, process.env[key]])), home: process.env.CODEX_HOME, aliases: Object.keys(process.env).filter(key => key.startsWith('ORCA_CODEX_USAGE_ENV_')) }))`
        )
        writeFileSync(
          join(bin, 'codex'),
          `#!/bin/sh\nexec ${quoteHiddenRateLimitShellValue(process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath)} ${quoteHiddenRateLimitShellValue(probe)} "$@"\n`,
          { mode: 0o700 }
        )
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        readRpc.mockResolvedValue({
          provider: 'codex',
          session: null,
          weekly: null,
          status: 'ok',
          updatedAt: 1
        })
        const networkProxySettings = {
          httpProxyUrl: "http://fixture:pass'word$@proxy.fixture.invalid:8080",
          httpProxyBypassRules: bypassRules
        }
        await fetchCodexRateLimits({
          codexHomePath: '\\\\wsl.localhost\\FixtureDistro\\home\\fixture\\.codex',
          networkProxySettings
        })
        const spec = spawn.mock.calls[0]?.[0]
        const guestEnv: Record<string, string> = {
          PATH: `${bin}:/usr/bin:/bin`,
          TMPDIR: root,
          ORCA_BACKGROUND_LAUNCH: '1'
        }
        for (const key of spec.env.WSLENV.split(':')) {
          if (key.startsWith('ORCA_CODEX_USAGE_ENV_')) {
            guestEnv[key] = spec.env[key]
          }
        }
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
        const result = runProcessSync({
          program: '/bin/sh',
          args: ['-c', spec.args.at(-1)],
          env: guestEnv,
          timeoutMs: 5_000
        })
        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toEqual({
          proxy: buildConfiguredProxyEnv(networkProxySettings),
          home: '/home/fixture/.codex',
          aliases: []
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
