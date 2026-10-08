import { describe, expect, it } from 'vitest'
import { resolveArchiveHookCommandPaths } from './archive-hook-command-paths'

const POSIX = {
  yamlRoot: '/repo/main',
  cwd: '/repo/old',
  shell: 'posix' as const
}

function files(present: string[]) {
  const known = new Set(present)
  return (absolute: string) => known.has(absolute)
}

describe('resolveArchiveHookCommandPaths', () => {
  it('anchors a relative script that exists only on the yaml checkout', () => {
    const command = resolveArchiveHookCommandPaths('bash scripts/worktree-archive.sh', {
      ...POSIX,
      isFile: files(['/repo/main/scripts/worktree-archive.sh'])
    })
    expect(command).toBe("bash '/repo/main/scripts/worktree-archive.sh'")
  })

  it('keeps a relative script the worktree itself has', () => {
    const command = resolveArchiveHookCommandPaths('bash scripts/worktree-archive.sh', {
      ...POSIX,
      isFile: files([
        '/repo/main/scripts/worktree-archive.sh',
        '/repo/old/scripts/worktree-archive.sh'
      ])
    })
    expect(command).toBe('bash scripts/worktree-archive.sh')
  })

  it('leaves commands that are not paths alone', () => {
    const isFile = files(['/repo/main/pnpm'])
    expect(resolveArchiveHookCommandPaths('pnpm worktree:archive', { ...POSIX, isFile })).toBe(
      'pnpm worktree:archive'
    )
  })

  it('does not climb out of the yaml checkout', () => {
    const command = resolveArchiveHookCommandPaths('bash ../outside.sh', {
      ...POSIX,
      isFile: files(['/repo/outside.sh'])
    })
    expect(command).toBe('bash ../outside.sh')
  })

  it('quotes a yaml root that contains spaces', () => {
    const command = resolveArchiveHookCommandPaths('bash scripts/a.sh', {
      yamlRoot: '/repo/my project',
      cwd: '/repo/old',
      shell: 'posix',
      isFile: files(['/repo/my project/scripts/a.sh'])
    })
    expect(command).toBe("bash '/repo/my project/scripts/a.sh'")
  })

  it('rewrites the opener of a heredoc and leaves the body', () => {
    const script = 'bash scripts/a.sh <<EOF\nscripts/a.sh\nEOF\n'
    const command = resolveArchiveHookCommandPaths(script, {
      ...POSIX,
      isFile: files(['/repo/main/scripts/a.sh'])
    })
    expect(command).toBe("bash '/repo/main/scripts/a.sh' <<EOF\nscripts/a.sh\nEOF\n")
  })

  it('does not rewrite a comment or an expansion', () => {
    const isFile = files(['/repo/main/scripts/a.sh'])
    expect(
      resolveArchiveHookCommandPaths('bash scripts/a.sh # scripts/a.sh', { ...POSIX, isFile })
    ).toBe("bash '/repo/main/scripts/a.sh' # scripts/a.sh")
    expect(resolveArchiveHookCommandPaths('bash $ROOT/scripts/a.sh', { ...POSIX, isFile })).toBe(
      'bash $ROOT/scripts/a.sh'
    )
  })

  it('quotes a Windows path for cmd.exe', () => {
    const command = resolveArchiveHookCommandPaths('bash scripts/a.sh', {
      yamlRoot: 'C:\\repo',
      cwd: 'C:\\wt',
      shell: 'cmd',
      isFile: files(['C:\\repo\\scripts\\a.sh'])
    })
    expect(command).toBe('bash "C:\\repo\\scripts\\a.sh"')
  })

  it('returns the command unchanged when yaml and cwd are the same directory', () => {
    const command = resolveArchiveHookCommandPaths('bash scripts/a.sh', {
      yamlRoot: '/repo/main',
      cwd: '/repo/main/',
      shell: 'posix',
      isFile: () => {
        throw new Error('same directory must not stat')
      }
    })
    expect(command).toBe('bash scripts/a.sh')
  })
})
