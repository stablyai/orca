import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'
import { resolveWindowsCmdShim } from './windows-cmd-shim-resolution'
import type { ProcessSpec } from './process-spec'

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: NodeSpawnOptions
}

/** Host-independent for Windows tests; recognized shim I/O failures fall back to cmd.exe. */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  const args = spec.args ?? []
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    serialization: spec.serialization,
    // GUI-subsystem parents otherwise spawn visible consoles that steal foreground input.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // shell:true loses argument escaping and disables windowsHide.
    shell: false,
    ...(spec.terminationBarrier && platform !== 'win32' ? { detached: true } : {})
  }

  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base }
  }

  // Direct shim resolution avoids cmd escaping, EDR obfuscation flags, and multiline-argument limits.
  const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env)
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...(shim.env ? { env: shim.env } : {}),
        // Node must quote argv normally after replacing the caller-owned cmd line.
        windowsVerbatimArguments: undefined
      }
    }
  }

  // Node rejects direct .cmd/.bat spawns; build the cmd line ourselves to preserve quoting and hiding.
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  }
}
