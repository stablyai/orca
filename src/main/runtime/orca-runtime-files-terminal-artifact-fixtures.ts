import { afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeFileCommands } from './orca-runtime-files'
import { resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'

/** Real on-disk artifacts outside the worktree, torn down after each test. */
export function useTerminalArtifactTempFiles(): {
  tempDirs: string[]
  tempFile: (name: string, content: string) => Promise<string>
} {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  async function tempFile(name: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
    tempDirs.push(dir)
    const filePath = join(dir, name)
    await writeFile(filePath, content)
    return filePath
  }

  return { tempDirs, tempFile }
}

export function absoluteFileTarget(result: {
  openTarget?: { kind: string; absolutePath?: string; grantId?: string }
}): { absolutePath: string; grantId: string } {
  if (
    result.openTarget?.kind !== 'absolute-file' ||
    typeof result.openTarget.absolutePath !== 'string' ||
    typeof result.openTarget.grantId !== 'string'
  ) {
    throw new Error('Expected an absolute terminal artifact target')
  }
  return result.openTarget as { absolutePath: string; grantId: string }
}

export function statAsFile() {
  resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
  statMock.mockResolvedValue({ isDirectory: () => false, size: 12, dev: 1, ino: 2, mtimeMs: 3 })
}

export function resolveTerminalArtifactPath(
  commands: RuntimeFileCommands,
  pathText: string,
  cwd: string | null = null,
  clientId = 'client-a',
  crossWorkspace = false
) {
  return commands.resolveTerminalPath('id:wt-1', pathText, cwd, clientId, 'term-1', crossWorkspace)
}
