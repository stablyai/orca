import type * as NodePty from 'node-pty'
import { canUseBunPty, spawnBunPty } from '../main/daemon/pty-subprocess/bun-pty-process'
import type { BunRuntime } from '../main/daemon/pty-subprocess/bun-pty-process-contract'

export type RelayPtyRuntimeKind = 'node' | 'bun'
export type RelayPtyBackend = 'node-pty' | 'bun-terminal'

export type RelayPtyModule = Readonly<{
  runtimeKind: RelayPtyRuntimeKind
  ptyBackend: RelayPtyBackend
  spawn: (
    shell: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    }
  ) => NodePty.IPty
}>

type BunGlobal = typeof globalThis & { Bun?: BunRuntime }

/** Selects Bun.Terminal when this relay is actually running under Bun. */
export async function loadRelayPtyRuntime(
  options: {
    skipNode?: boolean
    onNodeLoadError?: (error: unknown) => void
  } = {}
): Promise<RelayPtyModule | null> {
  const bun = (globalThis as BunGlobal).Bun
  if (canUseBunPty(bun)) {
    return {
      runtimeKind: 'bun',
      ptyBackend: 'bun-terminal',
      spawn(shell, args, options) {
        return spawnBunPty({
          file: shell,
          args,
          cwd: options.cwd,
          env: options.env,
          cols: options.cols,
          rows: options.rows
        })
      }
    }
  }

  if (options.skipNode) {
    return null
  }
  try {
    const nodePty = await import('node-pty')
    return {
      runtimeKind: 'node',
      ptyBackend: 'node-pty',
      spawn(shell, args, options) {
        return nodePty.spawn(shell, args, options)
      }
    }
  } catch (error) {
    options.onNodeLoadError?.(error)
    return null
  }
}
