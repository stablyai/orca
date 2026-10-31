import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  workspaceServerShellCommand,
  workspaceServerWorkingDirectory
} from './workspace-server-command'
vi.mock('../runtime/structured-agent-shell-environment', () => ({ hostShellEnvironment: vi.fn() }))
const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})
describe('server command execution', () => {
  it('passes exact command text through the selected shell family', () => {
    const command = 'pnpm dev --port 4008 && echo "ready"'
    expect(workspaceServerShellCommand('/bin/zsh', command, 'darwin').args).toEqual([
      '-lc',
      command
    ])
    expect(workspaceServerShellCommand('/bin/sh', command, 'linux').args).toEqual(['-c', command])
    expect(workspaceServerShellCommand('pwsh.exe', command, 'win32').args?.at(-1)).toBe(command)
    expect(workspaceServerShellCommand('cmd.exe', command, 'win32')).toMatchObject({
      windowsVerbatimArguments: true,
      args: ['/d', '/s', '/c', `"${command}"`]
    })
    expect(() => workspaceServerShellCommand('cmd.exe', 'echo a\necho b', 'win32')).toThrow()
  })
  it('keeps the working directory within the resolved workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-server-cwd-'))
    paths.push(root)
    await mkdir(path.join(root, 'frontend'))
    expect((await workspaceServerWorkingDirectory(root, 'frontend')).cwd).toMatch(/frontend$/)
    await expect(workspaceServerWorkingDirectory(root, '..')).rejects.toThrow(
      'inside its workspace'
    )
  })
})
