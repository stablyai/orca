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

  it('rewrites only a command word or an interpreter script, never other arguments', () => {
    const isFile = files([
      '/repo/main/archive.log',
      '/repo/main/notes.txt',
      '/repo/main/scripts/a.sh',
      '/repo/main/scripts/archive.sh'
    ])
    const resolve = (script: string) => resolveArchiveHookCommandPaths(script, { ...POSIX, isFile })
    expect(resolve('rm -f ./archive.log')).toBe('rm -f ./archive.log')
    expect(resolve('cat ./notes.txt')).toBe('cat ./notes.txt')
    expect(resolve('cp scripts/a.sh /tmp')).toBe('cp scripts/a.sh /tmp')
    expect(resolve('rm -f \\\n  ./archive.log')).toBe('rm -f \\\n  ./archive.log')
    expect(resolve('bash -s -- ./archive.log')).toBe('bash -s -- ./archive.log')
    expect(resolve('bash \\\n  -s ./archive.log')).toBe('bash \\\n  -s ./archive.log')
    expect(resolve('python3 - ./archive.log')).toBe('python3 - ./archive.log')
    expect(resolve('node --eval=0 ./archive.log')).toBe('node --eval=0 ./archive.log')
    expect(resolve('bash > \\\n./archive.log scripts/a.sh')).toBe(
      "bash > \\\n./archive.log '/repo/main/scripts/a.sh'"
    )
    expect(resolve('echo ">" && bash scripts/a.sh # note \\\nbash scripts/a.sh')).toBe(
      "echo \">\" && bash '/repo/main/scripts/a.sh' # note \\\nbash '/repo/main/scripts/a.sh'"
    )
    expect(resolve('bash scripts/a.sh ./notes.txt')).toBe(
      "bash '/repo/main/scripts/a.sh' ./notes.txt"
    )
    expect(resolve('./scripts/archive.sh')).toBe("'/repo/main/scripts/archive.sh'")
    expect(resolve('cd /tmp && CI=1 bash -e scripts/a.sh')).toBe(
      "cd /tmp && CI=1 bash -e '/repo/main/scripts/a.sh'"
    )
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

  it('does not let a comment or a quote open a heredoc', () => {
    const isFile = files(['/repo/main/scripts/a.sh'])
    expect(
      resolveArchiveHookCommandPaths('# example: cat <<EOF\nbash scripts/a.sh\n', {
        ...POSIX,
        isFile
      })
    ).toBe("# example: cat <<EOF\nbash '/repo/main/scripts/a.sh'\n")
    expect(
      resolveArchiveHookCommandPaths('echo "cat <<EOF"\nbash scripts/a.sh\n', { ...POSIX, isFile })
    ).toBe('echo "cat <<EOF"\nbash \'/repo/main/scripts/a.sh\'\n')
    expect(
      resolveArchiveHookCommandPaths("echo 'cat <<EOF'\nbash scripts/a.sh\n", { ...POSIX, isFile })
    ).toBe("echo 'cat <<EOF'\nbash '/repo/main/scripts/a.sh'\n")
  })

  it('leaves a redirection operand in the worktree', () => {
    const isFile = files(['/repo/main/scripts/a.sh'])
    expect(resolveArchiveHookCommandPaths('echo done > scripts/a.sh', { ...POSIX, isFile })).toBe(
      'echo done > scripts/a.sh'
    )
    expect(
      resolveArchiveHookCommandPaths('bash scripts/a.sh > scripts/a.sh', { ...POSIX, isFile })
    ).toBe("bash '/repo/main/scripts/a.sh' > scripts/a.sh")
    expect(
      resolveArchiveHookCommandPaths('bash scripts/a.sh 2>> scripts/a.sh', { ...POSIX, isFile })
    ).toBe("bash '/repo/main/scripts/a.sh' 2>> scripts/a.sh")
    expect(resolveArchiveHookCommandPaths('echo> scripts/a.sh', { ...POSIX, isFile })).toBe(
      'echo> scripts/a.sh'
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
    expect(escape('C:\\%USERNAME%\\repo')).toBe('bash C:\\^%USERNAME^%\\repo\\scripts\\a.sh')
  })

  it('finds the script after cmd.exe call or PowerShell -File and leaves other arguments', () => {
    const resolve = (script: string) =>
      resolveArchiveHookCommandPaths(script, {
        yamlRoot: 'C:\\repo',
        cwd: 'C:\\wt',
        shell: 'cmd',
        isFile: files([
          'C:\\repo\\scripts\\archive.cmd',
          'C:\\repo\\scripts\\a.ps1',
          'C:\\repo\\archive.log',
          'C:\\repo\\session.pssc'
        ])
      })
    expect(resolve('del /q ; .\\archive.log')).toBe('del /q ; .\\archive.log')
    expect(resolve('pwsh -ExecutionPolicy Bypass -File scripts\\a.ps1')).toBe(
      'pwsh -ExecutionPolicy Bypass -File C:\\repo\\scripts\\a.ps1'
    )
    expect(resolve('pwsh -ConfigurationFile ./session.pssc -File scripts\\a.ps1')).toBe(
      'pwsh -ConfigurationFile ./session.pssc -File C:\\repo\\scripts\\a.ps1'
    )
    expect(resolve('powershell -NoProfile -File ./scripts/a.ps1')).toBe(
      'powershell -NoProfile -File C:\\repo\\scripts\\a.ps1'
    )
    expect(resolve('powershell.exe -exec bypass -Fi scripts\\a.ps1')).toBe(
      'powershell.exe -exec bypass -Fi C:\\repo\\scripts\\a.ps1'
    )
    expect(resolve('pwsh -Command ./archive.log')).toBe('pwsh -Command ./archive.log')
    expect(resolve('pwsh -File')).toBe('pwsh -File')
    expect(resolve('call scripts\\archive.cmd')).toBe('call C:\\repo\\scripts\\archive.cmd')
    expect(resolve('scripts\\archive.cmd')).toBe('C:\\repo\\scripts\\archive.cmd')
    expect(resolve('del scripts\\archive.cmd')).toBe('del scripts\\archive.cmd')
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
