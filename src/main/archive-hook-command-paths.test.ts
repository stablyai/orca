import { describe, expect, it } from 'vitest'
import {
  archiveHookShellPathOnHost,
  resolveArchiveHookCommandPaths
} from './archive-hook-command-paths'

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

  it('ends a tab-stripped heredoc and rewrites the command after it', () => {
    const script = 'cat <<-EOF\n\tscripts/a.sh\n\tEOF\nbash scripts/a.sh\n'
    const command = resolveArchiveHookCommandPaths(script, {
      ...POSIX,
      isFile: files(['/repo/main/scripts/a.sh'])
    })
    expect(command).toBe("cat <<-EOF\n\tscripts/a.sh\n\tEOF\nbash '/repo/main/scripts/a.sh'\n")
    const literal = 'cat <<EOF\n\tEOF\nscripts/a.sh\nEOF\nbash scripts/a.sh\n'
    expect(
      resolveArchiveHookCommandPaths(literal, {
        ...POSIX,
        isFile: files(['/repo/main/scripts/a.sh'])
      })
    ).toBe("cat <<EOF\n\tEOF\nscripts/a.sh\nEOF\nbash '/repo/main/scripts/a.sh'\n")
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

  it('escapes a Windows path for cmd.exe without wrapping quotes', () => {
    const escape = (yamlRoot: string) =>
      resolveArchiveHookCommandPaths('bash scripts/a.sh', {
        yamlRoot,
        cwd: 'C:\\wt',
        shell: 'cmd',
        isFile: files([`${yamlRoot}\\scripts\\a.sh`])
      })
    expect(escape('C:\\repo')).toBe('bash C:\\repo\\scripts\\a.sh')
    expect(escape('C:\\repo dir')).toBe('bash C:\\repo^ dir\\scripts\\a.sh')
    expect(escape('C:\\repo\\a&b')).toBe('bash C:\\repo\\a^&b\\scripts\\a.sh')
    expect(escape('C:\\repo\\a^b')).toBe('bash C:\\repo\\a^^b\\scripts\\a.sh')
  })

  it('maps a WSL worktree beside the checkout back to a path Windows can stat', () => {
    expect(
      archiveHookShellPathOnHost(
        '/home/me/proj-wt/scripts/a.sh',
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
        '/home/me/proj'
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj-wt\\scripts\\a.sh')
    expect(archiveHookShellPathOnHost('/mnt/c/wt/scripts/a.sh', 'C:\\repo', '/mnt/c/repo')).toBe(
      'C:\\wt\\scripts\\a.sh'
    )
    expect(
      archiveHookShellPathOnHost(
        '/home/me/orca/workspaces/old/scripts/a.sh',
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
        '/home/me/proj'
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\orca\\workspaces\\old\\scripts\\a.sh')
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
