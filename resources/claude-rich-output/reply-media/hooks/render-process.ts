import type { EngineInterface, ImageSource } from 'claude-code'
import type { Failure, Frames } from '../types'

let lastFrameUse: { dir: string; at: number } | undefined

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
    try {
      const result: unknown = JSON.parse(ran.stdout)
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        return { error: 'renderer printed an invalid JSON object' }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bundled renderer records implement T; malformed and non-record output is rejected above.
      return result as T
    } catch {
      return {
        error:
          ran.stderr.trim().split('\n').at(-1) ||
          (ran.stdout.trim() ? 'renderer printed invalid JSON' : 'renderer printed no result')
      }
    }
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

export async function cachedFrames($: EngineInterface, frames: Frames | undefined) {
  if (
    frames === undefined ||
    (await isGone($, `${frames.dir}/f00001.png`)) ||
    (await isGone($, `${frames.dir}/f${String(frames.count).padStart(5, '0')}.png`))
  ) {
    return undefined
  }
  const now = await $.clock.now()
  // Leave more than the maximum ten-minute clip inside the fifteen-minute protection window.
  if (lastFrameUse?.dir === frames.dir && now - lastFrameUse.at < 4 * 60 * 1000) {
    return frames
  }
  const used = await run<Record<string, unknown>>($, ['video', 'touch'], {
    stdin: frames.dir,
    timeoutMs: 30_000
  })
  if ('error' in used) {
    return undefined
  }
  lastFrameUse = { dir: frames.dir, at: now }
  return frames
}

export async function cacheVideoFrames($: EngineInterface, clip: string) {
  const at = await $.clock.now()
  const frames = await run<Frames>($, ['video', 'frames'], { stdin: clip, timeoutMs: 120_000 })
  if (!('error' in frames)) {
    lastFrameUse = { dir: frames.dir, at }
  }
  return frames
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
