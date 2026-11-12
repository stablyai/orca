import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as AppServerSession from '../../app-server/codex-app-server-session'

const mocks = vi.hoisted(() => ({
  runCodexAppServerSession: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
vi.mock('../../app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
import {
  deriveCodexHookHashes,
  probeCodexVersion,
  sweepStaleCodexScratchHomes,
  type CodexHookAnswer
} from './codex-hook-trust-derivation'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from '../../hooks/definitions/codex-hook-definition'

const COMMAND = '/home/u/.orca/agent-hooks/codex-hook.sh'
const LABELS = CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
const hashesOf = (answer: CodexHookAnswer) => (answer.kind === 'hashes' ? answer.hashes : null)

type Scratch = { home: string; project: string }
type ListedHook = Record<string, unknown>

/** Codex 0.129+ includes hook approval hashes. */
function listed(sourcePath: string, label: string, groupIndex = 0, hash = `sha256:${label}`) {
  return {
    key: `${sourcePath}:${label}:${groupIndex}:0`,
    eventName: label,
    handlerType: 'command',
    command: COMMAND,
    sourcePath,
    source: 'user',
    displayOrder: 0,
    enabled: true,
    currentHash: hash,
    trustStatus: 'untrusted'
  }
}

function everyCopy(scratch: Scratch, hashFor: (label: string, copy: number) => string) {
  const home = join(scratch.home, 'hooks.json')
  const project = join(scratch.project, '.codex', 'hooks.json')
  return LABELS.flatMap((label) => [
    listed(home, label, 0, hashFor(label, 0)),
    listed(home, label, 2, hashFor(label, 1)),
    listed(project, label, 0, hashFor(label, 2))
  ])
}

function answerHooksList(respond: (scratch: Scratch) => ListedHook[]): Scratch[] {
  const scratches: Scratch[] = []
  mocks.runCodexAppServerSession.mockImplementation(
    async (
      invocation: { env?: Record<string, string> },
      body: (rpc: unknown) => Promise<unknown>
    ) => {
      const home = invocation.env!.CODEX_HOME!
      let project = ''
      await body({
        request: async (method: string, params: { cwds: string[] }) => {
          expect(method).toBe('hooks/list')
          project = params.cwds[0]!
        }
      })
      const scratch = { home, project }
      scratches.push(scratch)
      expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toContain('trust_level = "trusted"')
      return { data: [{ cwd: project, hooks: respond(scratch) }] }
    }
  )
  return scratches
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('deriveCodexHookHashes', () => {
  it("asks Codex in a throwaway home and trusted project holding Orca's entry, then removes both", async () => {
    const scratches = answerHooksList((scratch) => {
      const home = JSON.parse(readFileSync(join(scratch.home, 'hooks.json'), 'utf-8'))
      expect(Object.keys(home.hooks).sort()).toEqual([...CODEX_EVENTS].sort())
      expect(home.hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] },
        { hooks: [{ type: 'command', command: 'exit 0' }] },
        { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] }
      ])
      const project = JSON.parse(
        readFileSync(join(scratch.project, '.codex', 'hooks.json'), 'utf-8')
      )
      expect(project.hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] }
      ])
      return everyCopy(scratch, (label) => `sha256:${label}`)
    })

    const derived = await deriveCodexHookHashes('/bin/codex', COMMAND, 'codex-cli 0.150.1')

    expect(derived).toMatchObject({ kind: 'hashes', codexVersion: 'codex-cli 0.150.1' })
    expect(hashesOf(derived)?.stop).toBe('sha256:stop')
    expect(hashesOf(derived)?.interrupt).toBe('sha256:interrupt')
    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(1)
    expect(existsSync(scratches[0]!.home)).toBe(false)
    expect(existsSync(scratches[0]!.project)).toBe(false)
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('confirms a hash that differs by position with a second throwaway home before refusing', async () => {
    const scratches = answerHooksList((scratch) =>
      everyCopy(scratch, (label, copy) => (copy === 1 ? 'sha256:moved' : `sha256:${label}`))
    )

    const derived = await deriveCodexHookHashes('/bin/codex', COMMAND, 'codex-cli 0.170.0')

    expect(scratches).toHaveLength(2)
    expect(scratches[0]!.home).not.toBe(scratches[1]!.home)
    expect(derived).toEqual({
      kind: 'refused',
      codexVersion: 'codex-cli 0.170.0',
      failure:
        "Codex 0.170.0 hashes Orca's status hook differently by its file or position, so Orca does not approve it"
    })
  })

  it('gives `codex --version` a throwaway CODEX_HOME of its own', async () => {
    let versionHome = ''
    mocks.runProcess.mockImplementation(async (spec: { env: Record<string, string> }) => {
      versionHome = spec.env.CODEX_HOME!
      expect(existsSync(versionHome)).toBe(true)
      return { code: 0, stdout: 'codex-cli 0.150.1\n', stderr: '', timedOut: false }
    })

    expect(await probeCodexVersion('/bin/codex')).toBe('codex-cli 0.150.1')
    expect(existsSync(versionHome)).toBe(false)
    expect(rm).toHaveBeenLastCalledWith(versionHome, { recursive: true, force: true })
  })
})

describe('sweepStaleCodexScratchHomes', () => {
  it('removes scratch homes older than an hour that a quit left, and nothing else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sweep-test-'))
    vi.stubEnv('TMPDIR', root)
    vi.stubEnv('TEMP', root)
    vi.stubEnv('TMP', root)
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000)
    const dir = (name: string, at: Date) => {
      mkdirSync(join(root, name, 'home'), { recursive: true })
      utimesSync(join(root, name), at, at)
      return join(root, name)
    }
    try {
      const staleTrust = dir('orca-codex-hook-trust-old', hoursAgo(2))
      const staleVersion = dir('orca-codex-version-old', hoursAgo(2))
      const live = dir('orca-codex-hook-trust-live', new Date())
      const unrelated = dir('someone-else-old', hoursAgo(2))

      await sweepStaleCodexScratchHomes()

      expect([staleTrust, staleVersion, live, unrelated].map(existsSync)).toEqual([
        false,
        false,
        true,
        true
      ])
    } finally {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
