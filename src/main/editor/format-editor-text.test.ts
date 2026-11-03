import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
import type { Repo } from '../../shared/repo-types'
import { DEFAULT_FORMATTER_INCLUDE } from '../../shared/editor-formatter'
import { formatEditorText } from './format-editor-text'

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})

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

  it('does not spawn for unconfigured projects, other hosts, or excluded files', async () => {
    expect(
      await formatEditorText(store, { ...target(), path: join(root, 'a.png') }, 'text')
    ).toEqual({ kind: 'skipped' })
    expect(
      await formatEditorText(store, { ...target(), executionHostId: 'ssh:other' }, 'text')
    ).toEqual({ kind: 'skipped' })
    delete repo.editorFormatter
    expect(await formatEditorText(store, target(), 'text')).toEqual({ kind: 'skipped' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('checks host support only after a configured formatter applies', async () => {
    const unsupported = vi.fn(() => {
      throw new Error('unsupported host')
    })
    expect(
      await formatEditorText(store, { ...target(), path: join(root, 'a.png') }, 'text', unsupported)
    ).toEqual({ kind: 'skipped' })
    expect(unsupported).not.toHaveBeenCalled()
    await expect(formatEditorText(store, target(), 'text', unsupported)).rejects.toThrow(
      'unsupported host'
    )
    expect(runProcess).not.toHaveBeenCalled()
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

  it.each([
    [{ timedOut: true }, 'timed out'],
    [{ outputTruncated: true }, 'output exceeded']
  ])('refuses incomplete formatter output (%j)', async (result, message) => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: 'partial',
      stderr: '',
      ...result
    })
    await expect(formatEditorText(store, target(), 'input')).rejects.toThrow(message)
  })
})
