import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureCursorSdkLoginFromSessionOnce } from './cursor-sdk-session-login'
import { cursorSdkHomePath } from './cursor-structured-location-support'
import { runProcess, spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import {
  parseCursorSidecarEvent,
  type CursorSdkListedModel,
  type CursorSidecarCommand,
  type CursorSidecarEvent,
  type CursorSidecarStart
} from './cursor-sdk-protocol'

const ENTRY_FILENAME = 'cursor-sdk-sidecar.js'

const listedModelSchema: z.ZodType<CursorSdkListedModel> = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  parameters: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        values: z.array(z.object({ value: z.string(), displayName: z.string().optional() }))
      })
    )
    .optional(),
  variants: z
    .array(
      z.object({
        isDefault: z.boolean().optional(),
        params: z.array(z.object({ id: z.string(), value: z.string() }))
      })
    )
    .optional()
})

export type CursorSdkConnection = {
  readonly pid: number
  send(command: CursorSidecarCommand): void
  onEvent(listener: (event: CursorSidecarEvent) => void): () => void
  /** True once the process exit was observed. `force` kills a start that ignores stdin closing. */
  close(options?: { force?: boolean }): Promise<boolean>
}

export function resolveCursorSdkSidecarEntry(
  moduleDir: string,
  resourcesPath: string | undefined = process.resourcesPath,
  pathExists: (path: string) => boolean = existsSync
): string {
  const toUnpackedDir = (dir: string): string =>
    dir.replace(/([\\/])app\.asar(?=([\\/]|$))/, '$1app.asar.unpacked')
  for (const baseDir of [moduleDir, join(moduleDir, '..')].map(toUnpackedDir)) {
    const candidate = join(baseDir, ENTRY_FILENAME)
    if (pathExists(candidate)) {
      return candidate
    }
  }
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'app.asar.unpacked', 'out', 'main', ENTRY_FILENAME)
    if (pathExists(packaged)) {
      return packaged
    }
  }
  return join(process.cwd(), 'out', 'main', ENTRY_FILENAME)
}

function cursorSidecarEnv(apiKey: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    SystemRoot: process.env.SystemRoot,
    ELECTRON_RUN_AS_NODE: '1',
    CURSOR_SDK_HOME: cursorSdkHomePath()
  }
  if (apiKey) {
    env.CURSOR_API_KEY = apiKey
  }
  return env
}

export async function openCursorSdkConnection(input: {
  apiKey?: string
  entryPath?: string
}): Promise<CursorSdkConnection> {
  if (!input.apiKey) {
    await ensureCursorSdkLoginFromSessionOnce()
  }
  const entryPath = input.entryPath ?? resolveCursorSdkSidecarEntry(__dirname)
  const child = spawnProcess({
    program: process.execPath,
    args: [entryPath],
    env: cursorSidecarEnv(input.apiKey),
    cwd: process.cwd()
  })
  return connectionFromChild(child)
}

export async function listCursorSdkModels(input: {
  apiKey?: string
  entryPath?: string
}): Promise<CursorSdkListedModel[]> {
  if (!input.apiKey) {
    await ensureCursorSdkLoginFromSessionOnce()
  }
  const entryPath = input.entryPath ?? resolveCursorSdkSidecarEntry(__dirname)
  const result = await runProcess({
    program: process.execPath,
    args: [entryPath, 'models'],
    env: cursorSidecarEnv(input.apiKey),
    timeoutMs: 30_000
  })
  const line = result.stdout
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.startsWith('{'))
  if (!line) {
    throw new Error(result.stderr.trim() || 'Cursor model list returned nothing')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('Cursor model list was not a catalog')
  }
  if (typeof parsed !== 'object' || parsed === null || !('models' in parsed)) {
    throw new Error('Cursor model list was not a catalog')
  }
  const models = parsed.models
  if (!Array.isArray(models)) {
    return []
  }
  return models.flatMap((model: unknown) => {
    const result = listedModelSchema.safeParse(model)
    return result.success ? [result.data] : []
  })
}

function connectionFromChild(child: PipedChildProcess): CursorSdkConnection {
  const listeners = new Set<(event: CursorSidecarEvent) => void>()
  let buffer = ''
  let exitCode: number | null = null
  let exitWait: Promise<boolean> | null = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseCursorSidecarEvent(line)
      if (event) {
        if (event.type === 'exited') {
          exitCode = event.code
        }
        for (const listener of listeners) {
          listener(event)
        }
      }
    }
  })
  // Why: spawn can emit error and never exit, and a write after the sidecar is gone is EPIPE on stdin.
  let settled = false
  const observeExit = (code: number | null): void => {
    if (settled) {
      return
    }
    settled = true
    exitCode = code ?? -1
    const event: CursorSidecarEvent = { type: 'exited', code }
    for (const listener of listeners) {
      listener(event)
    }
  }
  child.stdin.on('error', () => {})
  child.on('error', () => observeExit(null))
  child.on('exit', (code) => observeExit(code))
  return {
    pid: child.pid ?? 0,
    send(command: CursorSidecarCommand) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close(options?: { force?: boolean }) {
      exitWait ??= new Promise((resolve) => {
        if (settled || exitCode !== null || child.exitCode !== null) {
          resolve(true)
          return
        }
        const done = (): void => resolve(true)
        child.once('exit', done)
        child.once('error', done)
        if (options?.force) {
          try {
            child.kill()
          } catch {
            resolve(true)
          }
          return
        }
        child.stdin.end()
      })
      return exitWait
    }
  }
}

export type { CursorSidecarStart }
