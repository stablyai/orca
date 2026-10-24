import type { EngineInterface, ImageSource } from 'claude-code'
import type { Failure } from '../types'

/**
 * Runs a renderer script, named with its arguments, and answers what it
 * printed, or why it failed: the script's `Error:` line, or the last line it
 * wrote.
 */
export async function run<T>(
  $: EngineInterface,
  [script, ...args]: string[],
  init: { stdin: string; timeoutMs: number; cwd?: string }
): Promise<T | Failure> {
  const ran = await $.process
    .run(['node', `${$.plugin.root}/render/${script}.mjs`, ...args], init)
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (ran.exitCode === 0) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the bundled renderer scripts produce this JSON; errors use the nonzero exit path.
    return JSON.parse(ran.stdout) as T
  }

  // More than one `Error:` when the tool a script ran opens its own message
  // with it, as `sips` does.
  const line = /^(?:\w*Error: )+(.+)$/m.exec(ran.stderr)?.[1]

  return { error: line ?? ran.stderr.trim().split('\n').at(-1) ?? '' }
}

/** Whether the disk says a picture's file is not there; no answer at all is not that. */
export function isGone($: EngineInterface, file: string) {
  return $.fs.stat(file).then(
    () => false,
    (error: unknown) => /ENOENT/.test(String(error))
  )
}

/**
 * Inline small PNGs so remote terminals do not fetch every frame through a
 * separate file request. The engine accepts up to 2 MiB of decoded bytes;
 * larger images retain the file transport, which Orca can also read remotely.
 */
export async function imageSource($: EngineInterface, file: string): Promise<ImageSource> {
  const stat = await $.fs.stat(file)
  if (stat.size > 2 * 1024 * 1024) {
    return { file, format: 'png' }
  }
  const { base64 } = await $.fs.read(file, { as: 'bytes' })

  return { png: base64 }
}
