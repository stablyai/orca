import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
import type { Repo } from '../../shared/repository/repo-types'
import { DEFAULT_FORMATTER_INCLUDE } from '../../shared/editor/formatting/editor-formatter'
import { formatEditorText } from './format-editor-text'

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})

const originalPlatform = process.platform

describe('project formatter execution', () => {
  let root: string
  let repo: Repo
  const store = { getRepos: () => [repo] }
  const target = () => ({
    path: join(root, 'a.ts'),
    worktree: { path: root, repoId: 'repo' },
    executionHostId: 'local' as const
  })
  const command = (script: string): string => `"${process.execPath}" -e '${script}'`

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'orca-formatter-'))
    await writeFile(join(root, 'a.ts'), 'disk baseline')
    repo = {
      id: 'repo',
      path: root,
      displayName: 'Project',
      badgeColor: '',
      addedAt: 0,
      kind: 'folder',
      editorFormatter: {
        command: command(
          'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(s.trim()+"\\n"))'
        ),
        include: [DEFAULT_FORMATTER_INCLUDE]
      }
    }
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('formats the buffer through stdin without changing disk, using the workspace cwd and path', async () => {
    expect(await formatEditorText(store, target(), '  const a=1;  ')).toEqual({
      kind: 'formatted',
      text: 'const a=1;\n'
    })
    expect(await readFile(target().path, 'utf8')).toBe('disk baseline')
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: root, input: '  const a=1;  ' })
    )
  })

  it('reports the formatter failure and never changes the saved file', async () => {
    repo.editorFormatter!.command = command('process.stderr.write("syntax error");process.exit(2)')
    await expect(formatEditorText(store, target(), 'input')).rejects.toThrow('syntax error')
    expect(await readFile(target().path, 'utf8')).toBe('disk baseline')
  })

  it('refuses a successful command that would erase a non-empty buffer', async () => {
    repo.editorFormatter!.command = command('process.exit(0)')
    await expect(formatEditorText(store, target(), 'const x = 1')).rejects.toThrow(
      'returned no text'
    )
    expect(await readFile(target().path, 'utf8')).toBe('disk baseline')
  })

  it('formats a new file without creating it before the guarded save', async () => {
    const path = join(root, 'new.ts')
    expect(await formatEditorText(store, { ...target(), path }, '  new  ')).toEqual({
      kind: 'formatted',
      text: 'new\n'
    })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a linked file outside the workspace before starting the formatter',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'orca-formatter-outside-'))
      try {
        await writeFile(join(outside, 'outside.ts'), 'outside')
        await symlink(join(outside, 'outside.ts'), join(root, 'linked.ts'))
        await expect(
          formatEditorText(store, { ...target(), path: join(root, 'linked.ts') }, 'input')
        ).rejects.toThrow('outside its workspace')
        expect(runProcess).not.toHaveBeenCalled()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  it('spawns a Windows PATH .cmd formatter shim by its resolved path', async () => {
    const pathDir = join(root, 'bin')
    await mkdir(pathDir, { recursive: true })
    await writeFile(join(pathDir, 'mock-fmt'), '#!/bin/sh\n')
    await writeFile(join(pathDir, 'mock-fmt.cmd'), '@echo off\r\n')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('PATH', pathDir)
    vi.stubEnv('PATHEXT', '.EXE;.cmd')
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: 'formatted\n',
      stderr: '',
      timedOut: false
    })

    repo.editorFormatter!.command = 'mock-fmt --stdin-filepath "${file}"'
    expect(await formatEditorText(store, target(), 'const a=1;')).toEqual({
      kind: 'formatted',
      text: 'formatted\n'
    })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: `${pathDir}/mock-fmt.cmd`,
        args: ['--stdin-filepath', target().path]
      })
    )
  })

  it('resolves a worktree-relative Windows formatter shim without matching an extensionless sibling', async () => {
    const localBin = join(root, 'node_modules', '.bin')
    await mkdir(localBin, { recursive: true })
    await writeFile(join(localBin, 'mock-fmt'), '#!/bin/sh\n')
    await writeFile(join(localBin, 'mock-fmt.cmd'), '@echo off\r\n')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('PATH', '')
    vi.stubEnv('PATHEXT', '.EXE;.cmd')
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: 'formatted\n',
      stderr: '',
      timedOut: false
    })

    repo.editorFormatter!.command =
      './node_modules/.bin/mock-fmt --stdin-filepath "${relativeFile}"'
    expect(await formatEditorText(store, target(), 'const a=1;')).toEqual({
      kind: 'formatted',
      text: 'formatted\n'
    })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: `${localBin}/mock-fmt.cmd`,
        args: ['--stdin-filepath', 'a.ts']
      })
    )
  })

  it('spawns the bare formatter name on Windows when PATH has no match', async () => {
    const emptyDir = join(root, 'empty-bin')
    await mkdir(emptyDir, { recursive: true })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('PATH', emptyDir)
    vi.stubEnv('PATHEXT', '.EXE;.cmd')
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: 'formatted\n',
      stderr: '',
      timedOut: false
    })

    repo.editorFormatter!.command = 'missing-fmt --stdin-filepath "${file}"'
    await formatEditorText(store, target(), 'const a=1;')
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ program: 'missing-fmt' }))
  })

  it('leaves POSIX formatter commands to PATH lookup by bare name', async () => {
    const pathDir = join(root, 'bin')
    await mkdir(pathDir, { recursive: true })
    const binary = join(pathDir, 'mock-fmt')
    await writeFile(binary, '#!/bin/sh\n')
    if (originalPlatform !== 'win32') {
      await chmod(binary, 0o755)
    }
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.stubEnv('PATH', pathDir)
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: 'formatted\n',
      stderr: '',
      timedOut: false
    })

    repo.editorFormatter!.command = 'mock-fmt --stdin-filepath "${file}"'
    await formatEditorText(store, target(), 'const a=1;')
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ program: 'mock-fmt' }))
  })

  it.skipIf(process.platform !== 'win32')(
    'formats end-to-end through real Windows .cmd shims on PATH and under node_modules/.bin',
    async () => {
      const localBin = join(root, 'node_modules', '.bin')
      const pathDir = join(root, 'bin')
      await Promise.all([mkdir(localBin, { recursive: true }), mkdir(pathDir, { recursive: true })])

      const worker = join(root, 'fmt-worker.js')
      await writeFile(
        worker,
        'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(s.trim().toUpperCase()+"\\n"));'
      )
      const shimBody = `@echo off\r\n"${process.execPath}" "${worker}" %*\r\n`

      await writeFile(join(localBin, 'mock-fmt'), '#!/bin/sh\nexit 1\n')
      await writeFile(join(localBin, 'mock-fmt.cmd'), shimBody)
      repo.editorFormatter!.command = './node_modules/.bin/mock-fmt --stdin-filepath "${file}"'
      expect(await formatEditorText(store, target(), '  const a = 1;  ')).toEqual({
        kind: 'formatted',
        text: 'CONST A = 1;\n'
      })

      await writeFile(join(pathDir, 'mock-path-fmt'), '#!/bin/sh\nexit 1\n')
      await writeFile(join(pathDir, 'mock-path-fmt.cmd'), shimBody)
      vi.stubEnv('PATH', `${pathDir};${process.env.PATH ?? ''}`)
      repo.editorFormatter!.command = 'mock-path-fmt --stdin-filepath "${relativeFile}"'
      expect(await formatEditorText(store, target(), '  hello  ')).toEqual({
        kind: 'formatted',
        text: 'HELLO\n'
      })
    }
  )
})
