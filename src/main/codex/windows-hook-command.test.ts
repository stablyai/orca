import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createServer } from 'node:http'
import { runProcess } from '../../shared/child-process/run-process'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { getManagedCommand, CODEX_EVENTS } from './codex-hook-definition'
import { getManagedScript } from './codex-hook-script'
import {
  createManagedCommandMatcher,
  wrapWindowsCmdHookCommand
} from '../agent-hooks/installer-utils'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
afterEach(() => vi.restoreAllMocks())

describe('Codex Windows hook command', () => {
  it.each(['测试用户', '홍길동', '日本語', 'rené', '测试 用户', "测试 O'Brien"])(
    'uses the existing PowerShell host for %s without a second interpreter',
    (profile) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const path = `C:\\Users\\${profile}\\.orca\\agent-hooks\\codex-hook.cmd`
      const command = getManagedCommand(path)
      expect(command).not.toMatch(/powershell\.exe|EncodedCommand|Set-ExecutionPolicy/)
      expect(command).toContain(`-LiteralPath '${path.replaceAll("'", "''")}' -PathType Leaf`)
      expect(command).toContain(`[Console]::In.ReadToEnd()`)
      expect(createManagedCommandMatcher('codex-hook.cmd')(command)).toBe(true)
      expect(wrapWindowsCmdHookCommand(path)).toContain('-EncodedCommand')
    }
  )

  it('preserves the existing ASCII command and POSIX launcher', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = 'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd'
    expect(getManagedCommand(path)).toBe(path)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(getManagedCommand('/home/测试/.orca/agent-hooks/codex-hook.sh')).toContain(
      "[ -x '/home/测试/.orca/agent-hooks/codex-hook.sh' ]"
    )
  })
})

const windowsPowerShell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const windowsPwsh = (process.env.PATH ?? '')
  .split(delimiter)
  .map((directory) => join(directory, 'pwsh.exe'))
  .find((file) => existsSync(file))

describe.skipIf(process.platform !== 'win32')('Codex hook delivery through PowerShell', () => {
  it.each([windowsPowerShell, ...(windowsPwsh ? [windowsPwsh] : [])])(
    'delivers all eight events exactly once from a Unicode profile through %s',
    async (shell) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-cjk-'))
      const home = join(root, "测试 사용자 O'Brien")
      mkdirSync(home)
      const scriptPath = join(home, 'codex-hook.cmd')
      writeFileSync(scriptPath, getManagedScript())
      const posts: URLSearchParams[] = []
      const tokens: unknown[] = []
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          tokens.push(req.headers['x-orca-agent-hook-token'])
          posts.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
          res.writeHead(204).end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Missing listener port')
      }
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
        ),
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_AGENT_HOOK_PORT: String(address.port),
        ORCA_AGENT_HOOK_TOKEN: 'unicode-test-token',
        ORCA_PANE_KEY: 'unicode-tab:unicode-leaf',
        ORCA_WORKTREE_ID: 'C:\\folder workspace\\测试 & repo'
      }
      const payloads = CODEX_EVENTS.map((hook_event_name) =>
        JSON.stringify({
          hook_event_name,
          prompt: '测试 한국어 😀 " \\ \n & %PATH% ! $HOME '.repeat(7000)
        })
      )
      const invoke = (command: string, input: string) =>
        runProcess({
          program: shell,
          args: ['-NoProfile', '-Command', command],
          input,
          env,
          timeoutMs: 10_000,
          terminationBarrier: true
        })
      try {
        for (let offset = 0; offset < payloads.length; offset += 4) {
          const results = await Promise.all(
            payloads
              .slice(offset, offset + 4)
              .map((payload) => invoke(getManagedCommand(scriptPath), payload))
          )
          for (const result of results) {
            expect(result).toMatchObject({ code: 0, stdout: '', stderr: '', timedOut: false })
          }
        }
        expect(posts).toHaveLength(CODEX_EVENTS.length)
        expect(tokens).toEqual(CODEX_EVENTS.map(() => 'unicode-test-token'))
        expect(posts.map((post) => post.get('payload')).sort()).toEqual([...payloads].sort())
        for (const post of posts) {
          expect(post.get('paneKey')).toBe(env.ORCA_PANE_KEY)
          expect(post.get('worktreeId')).toBe(env.ORCA_WORKTREE_ID)
        }
        await new Promise<void>((resolve) => server.close(() => resolve()))
        expect(await invoke(getManagedCommand(scriptPath), payloads[0])).toMatchObject({
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false
        })
        rmSync(scriptPath)
        expect(await invoke(getManagedCommand(scriptPath), payloads[0])).toMatchObject({
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false
        })
        expect(posts).toHaveLength(CODEX_EVENTS.length)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await removeTree(root)
      }
    },
    30_000
  )
})
