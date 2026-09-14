import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWindowsGrokHookScript } from './windows-grok-hook-script'

/**
 * Conservative model of cmd's read-then-evaluate order: `%VAR:~n%` is expanded
 * while the line is read, so a read is only safe once an earlier line has proven
 * the variable defined. A value we cannot prove non-empty counts as undefined.
 */
function findUnguardedSubstringReads(lines: readonly string[]): string[] {
  const defined = new Set<string>()
  const unguarded: string[] = []

  for (const line of lines) {
    for (const [, name] of line.matchAll(/%([A-Za-z_]\w*):~/g)) {
      if (!defined.has(name)) {
        unguarded.push(line)
      }
    }
    const guarded = line.match(/^if not defined (\w+) goto :/)
    if (guarded) {
      defined.add(guarded[1])
    }
    // A value is provably non-empty only if something outside an expansion survives:
    // `set "V=%OTHER%"` may undefine V, `set "V=%V%."` cannot. The lazy value stops at
    // the quote that closes the `set`, so a substitution like `%V:"=%` stays one token.
    for (const [, name, value] of line.matchAll(/set "(\w+)=(.*?)"(?=\s|$)/g)) {
      if (value.replaceAll(/%[^%]*%/g, '') === '') {
        defined.delete(name)
      } else {
        defined.add(name)
      }
    }
  }

  return unguarded
}

describe('buildWindowsGrokHookScript', () => {
  // Why (#9358 / #9941): an unguarded `%VAR:~n%` on an undefined variable leaves a
  // bare `~n` token, which cmd rejects at parse time and aborts the hook with 255.
  it('never reads a substring expansion unless the variable is defined', () => {
    const lines = buildWindowsGrokHookScript().split('\r\n')

    expect(lines.filter((line) => line.includes(':~')).length).toBeGreaterThan(0)
    expect(findUnguardedSubstringReads(lines)).toEqual([])
  })

  // Why: delayed expansion would eat every `!` in a percent-expanded value on the
  // curl line, corrupting grokHome/paneKey and dropping worktreeId.
  it('disables delayed expansion inherited from the caller', () => {
    const lines = buildWindowsGrokHookScript().split('\r\n')

    expect(lines).toContain('setlocal DisableDelayedExpansion')
    expect(lines.filter((line) => line.includes('!'))).toEqual([])
  })

  it('re-checks the envelope after appending the trailing-backslash sentinel', () => {
    const lines = buildWindowsGrokHookScript().split('\r\n')
    const appended = lines.indexOf(
      'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."'
    )

    expect(appended).toBeGreaterThan(-1)
    expect(lines[appended + 1]).toBe('if not "%ORCA_GROK_HOME:~4096,1%"=="" set "ORCA_GROK_HOME="')
  })
})

// Why: the failure mode is cmd's own parser, so only a real cmd.exe run proves it.
describe.skipIf(process.platform !== 'win32')('buildWindowsGrokHookScript (win32)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  function writeScript(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-grok-hook-'))
    dirs.push(dir)
    const scriptPath = join(dir, 'grok-hook.cmd')
    writeFileSync(scriptPath, buildWindowsGrokHookScript())
    return scriptPath
  }

  type HookRun = {
    status: number | null
    stderr: string
    grokHome: string | null
    paneKey: string | null
    worktreeId: string | null
    payload: string | null
  }

  const PANE_KEY = 'tab!1:pane!2'
  const WORKTREE_ID = 'repo::C:/Users/test/wip!fix'

  /**
   * Why: `spawnSync` would hold the event loop for the child's whole lifetime, so
   * the listener below could never answer curl and every field would read back null.
   */
  function runHook(
    grokHome: string | undefined,
    options: { delayedExpansion?: boolean } = {}
  ): Promise<HookRun> {
    return new Promise((resolve, reject) => {
      let posted: URLSearchParams | undefined
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          posted = new URLSearchParams(body)
          res.writeHead(200).end()
        })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ORCA_AGENT_HOOK_PORT: String(typeof address === 'object' && address ? address.port : 0),
          ORCA_AGENT_HOOK_TOKEN: 'test-token',
          ORCA_PANE_KEY: PANE_KEY,
          ORCA_WORKTREE_ID: WORKTREE_ID
        }
        delete env.ORCA_AGENT_HOOK_ENDPOINT
        delete env.GROK_HOME
        if (grokHome !== undefined) {
          env.GROK_HOME = grokHome
        }

        const flags = options.delayedExpansion ? ['/d', '/v:on', '/c'] : ['/d', '/c']
        const child = spawn('cmd.exe', [...flags, writeScript()], { env })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on('error', reject)
        child.stdin.end('{"session_id":"s"}')
        child.on('close', (status) => {
          server.close(() =>
            resolve({
              status,
              stderr,
              grokHome: posted?.get('grokHome') ?? null,
              paneKey: posted?.get('paneKey') ?? null,
              worktreeId: posted?.get('worktreeId') ?? null,
              payload: posted?.get('payload') ?? null
            })
          )
        })
      })
    })
  }

  it('exits 0 and posts an empty grokHome when GROK_HOME is unset', async () => {
    const result = await runHook(undefined)

    expect(result.stderr).not.toContain('syntax')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  it('exits 0 and posts an empty grokHome when GROK_HOME is empty', async () => {
    const result = await runHook('')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  it('posts a normal GROK_HOME unchanged', async () => {
    const result = await runHook('C:\\Users\\test\\.grok')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\.grok')
  })

  // Why: an unescaped trailing backslash would escape curl's closing argv quote and
  // swallow the payload option that follows it.
  it('neutralizes a trailing backslash in GROK_HOME', async () => {
    const result = await runHook('C:\\Users\\test\\.grok\\')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\.grok\\.')
  })

  // Why (#14221): `setx GROK_HOME "C:\path\"` stores `C:\path"` — the CRT turns the
  // `\"` into a literal quote. That quote unbalanced the trailing-backslash `if`, so
  // cmd aborted the whole script before curl and every Grok hook event failed.
  it('exits 0 and strips a trailing quote from GROK_HOME', async () => {
    const result = await runHook('C:\\Users\\test\\.grok"')

    expect(result.stderr).not.toContain('unexpected at this time')
    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\.grok')
    expect(result.payload).toBe('{"session_id":"s"}')
  })

  // Why: an embedded quote closed curl's `grokHome=` argument early, which swallowed
  // the `^` continuation and dropped the `payload@-` line — a silent, exit-0 failure.
  it('strips an embedded quote without truncating the curl arguments', async () => {
    const result = await runHook('C:\\Users\\a"b\\.grok')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\ab\\.grok')
    expect(result.payload).toBe('{"session_id":"s"}')
  })

  it('posts an empty grokHome when GROK_HOME is only a quote', async () => {
    const result = await runHook('"')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
    expect(result.payload).toBe('{"session_id":"s"}')
  })

  it('drops a GROK_HOME past the envelope limit', async () => {
    const result = await runHook(`C:\\${'a'.repeat(4094)}`)

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  // Why: the sentinel pushes a 4096-char value to 4097, which the listener rejects
  // outright — drop it here instead of posting a value that cannot be read back.
  it('drops a GROK_HOME the trailing-backslash sentinel would push past the limit', async () => {
    const result = await runHook(`C:\\${'a'.repeat(4092)}\\`)

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('')
  })

  it('preserves an exclamation mark in GROK_HOME', async () => {
    const result = await runHook('C:\\Users\\test\\a!b!c')

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\a!b!c')
  })

  // Why: a caller with delayed expansion on would otherwise consume `!` in every
  // posted field, not just grokHome.
  it('preserves exclamation marks when the caller enables delayed expansion', async () => {
    const result = await runHook('C:\\Users\\test\\a!b!c', { delayedExpansion: true })

    expect(result.status).toBe(0)
    expect(result.grokHome).toBe('C:\\Users\\test\\a!b!c')
    expect(result.paneKey).toBe(PANE_KEY)
    expect(result.worktreeId).toBe(WORKTREE_ID)
  })
})
