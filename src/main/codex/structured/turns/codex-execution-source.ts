import { runProcess } from '@orca/process-host'

export async function assertCodexExecutionSource(cwd: string, pin: string): Promise<void> {
  const options = {
    program: 'git',
    cwd,
    terminationBarrier: true,
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    killOnOutputLimit: true
  } as const
  const head = await runProcess({ ...options, args: ['rev-parse', 'HEAD'] })
  const dirty = await runProcess({
    ...options,
    args: ['status', '--porcelain', '--untracked-files=normal']
  })
  if (
    head.code !== 0 ||
    head.timedOut ||
    head.outputTruncated ||
    head.stdout.trim() !== pin ||
    dirty.code !== 0 ||
    dirty.timedOut ||
    dirty.outputTruncated ||
    dirty.stdout.trim()
  ) {
    throw new Error('Bounded Codex source does not match the admitted clean revision.')
  }
}
