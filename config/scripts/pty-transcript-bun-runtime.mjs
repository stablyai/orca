import { bunOwnedRuntimeArgs } from '../../src/shared/bun-owned-runtime-args.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Observe native bytes before the product adapter's streaming UTF-8 decoder. */
export function tapBunTerminalBytes(runtime, onBytes) {
  const tap = (options) => ({
    ...options,
    data(terminal, bytes) {
      onBytes(Buffer.from(bytes))
      options.data(terminal, bytes)
    }
  })
  return {
    Terminal: class extends runtime.Terminal {
      constructor(options) {
        super(tap(options))
      }
    },
    spawn(command, options) {
      return runtime.spawn(command, {
        ...options,
        terminal: 'data' in options.terminal ? tap(options.terminal) : options.terminal
      })
    }
  }
}

export async function spawnTranscriptPty(args, onBytes) {
  const { spawnBunPty } = await import('../../src/main/daemon/pty-subprocess/bun-pty-process.ts')
  const { resolveBunRuntime } =
    await import('../../src/main/daemon/pty-subprocess/bun-pty-process-capabilities.ts')
  const { createWindowsBunPtyLaunch } =
    await import('../../src/main/daemon/pty-subprocess/windows-bun-pty-launch.ts')
  const term = spawnBunPty(args, {
    runtime: tapBunTerminalBytes(resolveBunRuntime(), onBytes),
    createWindowsLaunch: (options) =>
      createWindowsBunPtyLaunch(options, {
        workerPath: join(
          import.meta.dirname,
          '../../src/main/daemon/pty-subprocess/windows-bun-pty-gate-entry.ts'
        )
      })
  })
  // The recorder consumes native bytes; do not retain the adapter's decoded replay buffer.
  const subscription = term.onData(() => {})
  term.onExit(() => subscription.dispose())
  return term
}

export async function relaunchTranscriptWithBun(
  root,
  argv,
  entry = join(root, 'config/scripts/capture-agent-pty-transcript.mjs')
) {
  const { ORCAD_BUN_VERSION } = await import('../../src/shared/orcad-bun-runtime.ts')
  if (process.versions.bun) {
    if (process.versions.bun !== ORCAD_BUN_VERSION) {
      throw new Error(`Capture requires Bun ${ORCAD_BUN_VERSION}`)
    }
    return null
  }
  const { orcadBunRuntimeFilename } = await import('../../src/shared/orcad-artifacts.ts')
  const filename = orcadBunRuntimeFilename(process.platform)
  const runtime = [
    process.env.BUN_EXECUTABLE,
    join(root, 'out/orcad', filename),
    join(root, 'out/cli-runtime', `${process.platform}-${process.arch}`, filename)
  ].find((candidate) => candidate && existsSync(candidate))
  if (!runtime) {
    throw new Error(
      'Prepare bundled Bun with node config/scripts/build-orcad-bun.mjs --runtime-only --out-dir out/orcad'
    )
  }
  const { runProcessSync } = await import('./script-child-process.mjs')
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*)$/i.test(key)) {
      delete env[key]
    }
  }
  const result = runProcessSync({
    program: runtime,
    env,
    args: [...bunOwnedRuntimeArgs(), entry, ...argv],
    stdio: 'inherit',
    timeoutMs: null
  })
  return result.code ?? 1
}
