import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment
} from '../../shared/app-environment'
import { ORCAD_BUN_VERSION, orcadBunVersionProbeArgs } from '../../shared/orcad-bun-runtime'
import { getMainHttpClient, setMainHttpClient } from '../network/http-client'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { createRunningWslRuntimeRunner, ensureWslBunRuntime } from './wsl-bun-runtime'
import type { WslSpec } from './wsl-runner'
import { verifyWslBunBrowserRelay } from './wsl-bun-browser-fixture'
import { verifyWslBunHookRelay } from './wsl-bun-hook-fixture'

const distro = process.env.ORCA_TEST_WSL_DISTRO

it.skipIf(process.platform !== 'win32' || !distro)(
  'provisions and repairs Bun offline, then carries browser and hook traffic through real WSL',
  async () => {
    if (!distro) {
      throw new Error('ORCA_TEST_WSL_DISTRO is required')
    }
    const hostRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-bun-'))
    const previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
    const previousHttp = getMainHttpClient()
    setAppEnvironment({
      getPath: () => hostRoot,
      getAppPath: () => hostRoot,
      getVersion: () => 'test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    let guestRoot: string | undefined
    try {
      const execution = createRunningWslRuntimeRunner(distro)
      guestRoot = await execution.run({
        program: 'mktemp',
        args: ['-d', '/tmp/orca-wsl-bun-XXXXXX'],
        loginPath: 'none'
      })
      if (!/^\/tmp\/orca-wsl-bun-[A-Za-z0-9]+$/.test(guestRoot)) {
        throw new Error(`Unexpected guest test directory: ${guestRoot}`)
      }
      const home = `${guestRoot}/home with '$ spaces`
      await execution.run({ program: 'mkdir', args: ['-p', home], loginPath: 'none' })
      const run = (spec: WslSpec): Promise<string> =>
        execution.run(
          spec.script !== undefined
            ? { ...spec, script: `export HOME=${shellEscape(home)}\n${spec.script}` }
            : {
                ...spec,
                program: 'env',
                args: [`HOME=${home}`, spec.program, ...(spec.args ?? [])]
              }
        )
      const isolated = { run, signal: execution.signal }
      let interrupted = false
      await expect(
        ensureWslBunRuntime({
          ...isolated,
          run: (spec) => {
            if (spec.script?.includes("trap 'rm -rf")) {
              interrupted = true
              return run({
                ...spec,
                script: spec.script.replace(/(\ncp --[^\n]+\n)/, '$1exit 23\n')
              })
            }
            return run(spec)
          }
        })
      ).rejects.toThrow('WSL runtime setup failed')
      expect(interrupted).toBe(true)
      expect(
        await run({
          script: `find ${shellEscape(`${home}/.cache/orca/runtimes`)} -name 'upload-*' -print`,
          loginPath: 'none'
        })
      ).toBe('')
      const lostAcknowledgement = new Error('Published runtime acknowledgement lost')
      await expect(
        ensureWslBunRuntime({
          ...isolated,
          run: async (spec) => {
            const result = await run(spec)
            if (spec.script?.includes("trap 'rm -rf")) {
              throw lostAcknowledgement
            }
            return result
          }
        })
      ).rejects.toBe(lostAcknowledgement)
      const executable = await ensureWslBunRuntime(isolated)
      expect(executable.startsWith(`${home}/.cache/orca/runtimes/`)).toBe(true)
      expect(
        await run({
          program: executable,
          args: orcadBunVersionProbeArgs('linux'),
          loginPath: 'none'
        })
      ).toBe(ORCAD_BUN_VERSION)
      setMainHttpClient({
        fetch: async () => {
          throw new Error('Cached runtime must not access the network')
        },
        proxySession: () => null
      })
      expect(await ensureWslBunRuntime(isolated)).toBe(executable)
      await run({ script: `printf damaged > ${shellEscape(executable)}`, loginPath: 'none' })
      const repaired = await ensureWslBunRuntime(isolated)
      expect(repaired).not.toBe(executable)
      expect(
        await run({
          program: repaired,
          args: orcadBunVersionProbeArgs('linux'),
          loginPath: 'none'
        })
      ).toBe(ORCAD_BUN_VERSION)
      expect(await ensureWslBunRuntime(isolated)).toBe(repaired)
      expect(await run({ program: 'cat', args: [executable], loginPath: 'none' })).toBe('damaged')
      expect(
        await run({
          script: `find ${shellEscape(`${home}/.cache/orca/runtimes`)} -name 'upload-*' -print`,
          loginPath: 'none'
        })
      ).toBe('')
      await verifyWslBunBrowserRelay({ distro, home, executable: repaired, run })
      await verifyWslBunHookRelay({ distro, home, executable: repaired, run })
      const aborted = createRunningWslRuntimeRunner(distro, AbortSignal.abort())
      await expect(ensureWslBunRuntime(aborted)).rejects.toMatchObject({ name: 'AbortError' })
      const absent = createRunningWslRuntimeRunner('orca-test-not-an-installed-distro')
      await expect(absent.run({ program: 'true', loginPath: 'none' })).rejects.toThrow(
        'not running'
      )
    } finally {
      setMainHttpClient(previousHttp)
      if (previousEnvironment) {
        setAppEnvironment(previousEnvironment)
      }
      if (guestRoot && /^\/tmp\/orca-wsl-bun-[A-Za-z0-9]+$/.test(guestRoot)) {
        await createRunningWslRuntimeRunner(distro).run({
          program: 'rm',
          args: ['-rf', '--', guestRoot],
          loginPath: 'none'
        })
      }
      await rm(hostRoot, { recursive: true, force: true })
    }
  },
  240_000
)
