import { access, readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

import { OMP_MISSION_SYSTEM_PROMPT, withOmpMissionProcessFiles } from './omp-mission-process-files'

const DISABLED_PROVIDERS = [
  'agents-md',
  'agents',
  'native',
  'claude-plugins',
  'claude',
  'codex',
  'cursor',
  'gemini',
  'mcp-json',
  'omp-plugins',
  'opencode',
  'vscode',
  'windsurf',
  'agent-plugins',
  'github'
]

type GuardApi = {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void
  setActiveTools: (tools: unknown[]) => unknown
  getActiveTools: () => unknown
}

function installGuard(source: string, api: GuardApi) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const stderr: string[] = []
  const processMock = {
    stderr: { write: (message: string) => stderr.push(message) },
    exit: vi.fn()
  }
  const module = { exports: {} as { default?: (api: GuardApi) => void } }
  const context = { module, exports: module.exports, process: processMock }
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText

  runInNewContext(output, context)
  const install = module.exports.default
  if (!install) {
    throw new Error('Expected generated OMP mission guard default export.')
  }
  install({ ...api, on: (event, handler) => handlers.set(event, handler) })
  return { handlers, processMock, stderr }
}

async function isMissing(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

describe('withOmpMissionProcessFiles', () => {
  it('creates a private Mission-only overlay and trusted tool-blocking extension', async () => {
    await withOmpMissionProcessFiles(async ({ configPath, extensionPath }) => {
      expect(basename(configPath)).toBe('config.yml')
      expect(basename(extensionPath)).toBe('planner-guard.mjs')
      expect(parse(await readFile(configPath, 'utf8'))).toEqual({
        disabledProviders: DISABLED_PROVIDERS,
        mcp: { enableProjectConfig: false },
        speechgen: { enabled: false }
      })
      expect(await readFile(configPath, 'utf8')).not.toMatch(/model|auth|approval|profile/i)
      expect(OMP_MISSION_SYSTEM_PROMPT).toBe(
        'You are Orca Mission Planner. Produce only the requested JSON plan. Do not execute the mission or call tools.'
      )

      if (process.platform !== 'win32') {
        await expect(stat(configPath)).resolves.toMatchObject({ mode: expect.any(Number) })
        expect((await stat(configPath)).mode & 0o777).toBe(0o600)
        expect((await stat(extensionPath)).mode & 0o777).toBe(0o600)
      }

      const extension = await readFile(extensionPath, 'utf8')
      const activeTools: unknown[] = ['stale-tool']
      const api: GuardApi = {
        on: () => {},
        setActiveTools: vi.fn(async (tools: unknown[]) => {
          activeTools.splice(0, activeTools.length, ...tools)
        }),
        getActiveTools: vi.fn(() => activeTools)
      }
      const harness = installGuard(extension, api)

      await harness.handlers.get('session_start')?.()
      expect(activeTools).toEqual([])
      activeTools.push('later-refresh')
      await harness.handlers.get('before_agent_start')?.()
      expect(activeTools).toEqual([])
      expect(api.setActiveTools).toHaveBeenCalledWith([])
      expect(harness.processMock.exit).not.toHaveBeenCalled()

      for (const toolName of ['unknown-tool', 'new-tool', 'mcp__server__tool']) {
        expect(harness.handlers.get('tool_call')?.({ toolName })).toEqual({
          block: true,
          reason: 'Orca Mission planning does not permit tool execution.'
        })
      }
    })
  })

  it.each([
    ['setActiveTools rejects', () => Promise.reject(new Error('unavailable')), () => []],
    ['getActiveTools rejects', async () => {}, () => Promise.reject(new Error('unavailable'))],
    ['getActiveTools is nonempty', async () => {}, () => ['refreshed-tool']]
  ])('fails closed when %s', async (_label, setActiveTools, getActiveTools) => {
    await withOmpMissionProcessFiles(async ({ extensionPath }) => {
      const extension = await readFile(extensionPath, 'utf8')
      const api: GuardApi = {
        on: () => {},
        setActiveTools,
        getActiveTools
      }
      const harness = installGuard(extension, api)

      await harness.handlers.get('session_start')?.()

      expect(harness.stderr).toEqual(['OMP mission planning guard failed closed.\n'])
      expect(harness.processMock.exit).toHaveBeenCalledWith(1)
    })
  })

  it('fails loading when the trusted OMP extension API is unsupported', async () => {
    await withOmpMissionProcessFiles(async ({ extensionPath }) => {
      const extension = await readFile(extensionPath, 'utf8')

      expect(() =>
        installGuard(extension, {
          on: () => {},
          setActiveTools: async () => {},
          getActiveTools: undefined as unknown as () => unknown
        })
      ).toThrow('Orca Mission Planner guard requires the OMP extension API.')
    })
  })

  it('cleans only its temporary files after success and callback failure', async () => {
    let successPaths: { configPath: string; extensionPath: string } | undefined
    await withOmpMissionProcessFiles(async (files) => {
      successPaths = files
    })
    expect(successPaths).toBeDefined()
    expect(await isMissing(successPaths!.configPath)).toBe(true)
    expect(await isMissing(successPaths!.extensionPath)).toBe(true)
    expect(await isMissing(dirname(successPaths!.configPath))).toBe(true)

    let failedPaths: { configPath: string; extensionPath: string } | undefined
    await expect(
      withOmpMissionProcessFiles(async (files) => {
        failedPaths = files
        throw new Error('callback failed')
      })
    ).rejects.toThrow('callback failed')
    expect(failedPaths).toBeDefined()
    expect(await isMissing(failedPaths!.configPath)).toBe(true)
    expect(await isMissing(failedPaths!.extensionPath)).toBe(true)
    expect(await isMissing(dirname(failedPaths!.configPath))).toBe(true)
  })

  it('uses distinct temporary paths for concurrent Mission planner calls', async () => {
    const paths = await Promise.all(
      Array.from({ length: 2 }, () => withOmpMissionProcessFiles(async (files) => ({ ...files })))
    )

    expect(paths[0]).not.toEqual(paths[1])
    await expect(
      Promise.all(
        paths.flatMap((files) => [isMissing(files.configPath), isMissing(files.extensionPath)])
      )
    ).resolves.toEqual([true, true, true, true])
  })
})
