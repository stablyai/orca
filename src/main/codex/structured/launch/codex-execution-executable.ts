import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { readCodexCliVersion } from './codex-cli-installation-error'
import type { AgentSessionExecutionExecutable } from '../../../../shared/agent-session/agent-session-execution-evidence'

export async function readCodexExecutionExecutable(
  command: string,
  prefixArgs: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<AgentSessionExecutionExecutable> {
  if (!isAbsolute(command) || prefixArgs.length) {
    throw new Error('Bounded Codex requires a native executable.')
  }
  const path = await realpath(command)
  const before = await stat(path)
  const file = await open(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    await file.read(magic, 0, 4, 0)
    // shortcut: qualify native macOS binaries only; qualify wrappers separately before admitting them.
    if (
      !['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(
        magic.toString('hex')
      )
    ) {
      throw new Error('Bounded Codex requires a native macOS executable.')
    }
  } finally {
    await file.close()
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  const { version } = await readCodexCliVersion({ program: path, cwd, env })
  const after = await stat(path)
  if (
    !version ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    (await realpath(command)) !== path
  ) {
    throw new Error('Bounded Codex executable identity changed.')
  }
  return { path, sha256: hash.digest('hex'), version }
}
