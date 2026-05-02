/* eslint-disable max-lines */
import { spawn, execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import * as pty from 'node-pty'

const execFileAsync = promisify(execFile)

export type DockerExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type DockerBuildImageOptions = {
  contextPath: string
  dockerfilePath: string
  tag: string
  timeoutMs?: number
  dockerfileContent?: string
  labels?: Record<string, string>
}

export type DockerCreateContainerOptions = {
  imageId: string
  workdir: string
  mounts: { source: string; target: string; readonly?: boolean }[]
  command?: string[]
  env?: Record<string, string>
  name?: string
  labels?: Record<string, string>
}

export type DockerExecOptions = {
  containerId: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
  allowExitCodes?: number[]
}

export type DockerExecSessionOptions = {
  containerId: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  tty?: boolean
  cols: number
  rows: number
}

export type DockerExecSession = {
  id: string
  write(data: string): void
  resize(cols: number, rows: number): void
  shutdown(immediate: boolean): Promise<void>
  sendSignal(signal: string): Promise<void>
  getCwd(): Promise<string>
  getInitialCwd(): Promise<string>
  clearBuffer(): Promise<void>
  acknowledgeDataEvent(charCount: number): void
  hasChildProcesses(): Promise<boolean>
  getForegroundProcess(): Promise<string | null>
  serialize(): Promise<string>
  revive(state: string): Promise<void>
  onData(callback: (data: string) => void): () => void
  onReplay(callback: (data: string) => void): () => void
  onExit(callback: (code: number) => void): () => void
}

export type DockerImageListEntry = {
  id: string
  repository: string
  tag: string
  size: string
}

export type DockerImageInspectInfo = {
  id: string
  repoTags: string[]
  labels: Record<string, string>
  sizeBytes: number
}

export type DockerEngineClientLike = {
  buildImage(options: DockerBuildImageOptions): Promise<{ imageId: string }>
  pullImage(image: string): Promise<void>
  createContainer(options: DockerCreateContainerOptions): Promise<{ id: string }>
  startContainer(id: string): Promise<void>
  inspectContainer(id: string): Promise<{
    id: string
    imageId: string
    running: boolean
    labels?: Record<string, string>
  }>
  exec(options: DockerExecOptions): Promise<DockerExecResult>
  spawnExec(options: DockerExecSessionOptions): Promise<DockerExecSession>
  listImages(options?: { label?: string }): Promise<DockerImageListEntry[]>
  inspectImage(id: string): Promise<DockerImageInspectInfo>
  removeImage(id: string): Promise<void>
  stopContainer(id: string): Promise<void>
  removeContainer(id: string): Promise<void>
}

export class DockerEngineClient implements DockerEngineClientLike {
  async buildImage(options: DockerBuildImageOptions): Promise<{ imageId: string }> {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'orca-docker-build-'))
    const dockerfilePath = tempDir ? path.join(tempDir, 'Dockerfile') : options.dockerfilePath

    try {
      if (options.dockerfileContent) {
        await writeFile(dockerfilePath, options.dockerfileContent, 'utf-8')
      }

      const iidFile = path.join(tempDir, 'iid')
      const args = [
        'build',
        '--iidfile',
        iidFile,
        '-f',
        options.dockerfileContent ? dockerfilePath : options.dockerfilePath,
        '-t',
        options.tag,
        ...labelArgs(options.labels),
        options.contextPath
      ]
      await execDocker(args, { timeoutMs: options.timeoutMs })
      const imageId = (await readFile(iidFile, 'utf-8')).trim()
      return { imageId }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async pullImage(image: string): Promise<void> {
    await execDocker(['pull', image])
  }

  async createContainer(options: DockerCreateContainerOptions): Promise<{ id: string }> {
    const args = ['create', '--workdir', options.workdir]
    for (const mount of options.mounts) {
      const flags = [`type=bind`, `source=${mount.source}`, `target=${mount.target}`]
      if (mount.readonly) {
        flags.push('readonly')
      }
      args.push('--mount', flags.join(','))
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }
    args.push(...labelArgs(options.labels))
    if (options.name) {
      args.push('--name', options.name)
    }
    args.push(options.imageId, ...(options.command ?? ['tail', '-f', '/dev/null']))
    const result = await execDocker(args)
    return { id: result.stdout.trim() }
  }

  async startContainer(id: string): Promise<void> {
    await execDocker(['start', id])
  }

  async inspectContainer(id: string): Promise<{
    id: string
    imageId: string
    running: boolean
    labels?: Record<string, string>
  }> {
    const result = await execDocker(['inspect', '--format', '{{json .}}', id])
    const parsed = JSON.parse(result.stdout.trim()) as {
      Id?: string
      Image?: string
      State?: { Running?: boolean }
      Config?: { Labels?: Record<string, string> | null }
    }
    return {
      id: parsed.Id ?? id,
      imageId: parsed.Image ?? '',
      running: parsed.State?.Running === true,
      labels: parsed.Config?.Labels ?? undefined
    }
  }

  async exec(options: DockerExecOptions): Promise<DockerExecResult> {
    const args = buildExecArgs(options)
    return execDocker(args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
      allowExitCodes: options.allowExitCodes
    })
  }

  async spawnExec(options: DockerExecSessionOptions): Promise<DockerExecSession> {
    const id = `docker-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const args = buildExecArgs({
      containerId: options.containerId,
      args: options.args,
      cwd: options.cwd,
      env: {
        ...options.env,
        COLUMNS: String(options.cols),
        LINES: String(options.rows)
      }
    })
    args.splice(1, 0, ...(options.tty ? ['-i', '-t'] : ['-i']))
    const dataListeners = new Set<(data: string) => void>()
    const replayListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(code: number) => void>()
    let buffer = ''
    let currentCwd = options.cwd
    let exitCode: number | null = null
    let writeInput: (data: string) => void
    let resizePty: (cols: number, rows: number) => void
    let killChild: (signal: NodeJS.Signals) => void

    const emitData = (chunk: string): void => {
      buffer += chunk
      for (const cb of dataListeners) {
        cb(chunk)
      }
    }
    const emitExit = (code: number | null | undefined): void => {
      exitCode = code ?? 0
      for (const cb of exitListeners) {
        cb(exitCode)
      }
    }

    if (options.tty) {
      // Why: interactive docker exec needs a real pseudoterminal so shells,
      // vim, and ncurses apps see TTY semantics in packaged Electron builds.
      const child = pty.spawn('docker', args, {
        cols: options.cols,
        rows: options.rows,
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])
        )
      })
      child.onData(emitData)
      child.onExit((event) => emitExit(event.exitCode))
      writeInput = (data) => child.write(data)
      resizePty = (cols, rows) => child.resize(cols, rows)
      killChild = (signal) => child.kill(signal)
    } else {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', emitData)
      child.stderr.on('data', emitData)
      child.on('close', emitExit)
      writeInput = (data) => child.stdin.write(data)
      resizePty = () => {
        if (exitCode === null) {
          child.kill('SIGWINCH')
        }
      }
      killChild = (signal) => child.kill(signal)
    }

    return {
      id,
      write(data): void {
        writeInput(data)
      },
      resize(cols, rows): void {
        resizePty(cols, rows)
      },
      async shutdown(immediate): Promise<void> {
        killChild(immediate ? 'SIGKILL' : 'SIGTERM')
      },
      async sendSignal(signal): Promise<void> {
        if (exitCode === null) {
          killChild(signal as NodeJS.Signals)
        }
      },
      async getCwd(): Promise<string> {
        return currentCwd
      },
      async getInitialCwd(): Promise<string> {
        return options.cwd
      },
      async clearBuffer(): Promise<void> {
        buffer = ''
      },
      acknowledgeDataEvent(_charCount): void {},
      async hasChildProcesses(): Promise<boolean> {
        return exitCode === null
      },
      async getForegroundProcess(): Promise<string | null> {
        return exitCode === null ? path.basename(options.args[0] ?? 'sh') : null
      },
      async serialize(): Promise<string> {
        return JSON.stringify({ cwd: currentCwd, buffer })
      },
      async revive(state): Promise<void> {
        try {
          const parsed = JSON.parse(state) as { cwd?: string; buffer?: string }
          currentCwd = parsed.cwd ?? currentCwd
          if (parsed.buffer) {
            buffer = parsed.buffer
            for (const cb of replayListeners) {
              cb(buffer)
            }
          }
        } catch {
          // Ignore stale serialized state from older builds.
        }
      },
      onData(callback): () => void {
        dataListeners.add(callback)
        return () => dataListeners.delete(callback)
      },
      onReplay(callback): () => void {
        replayListeners.add(callback)
        return () => replayListeners.delete(callback)
      },
      onExit(callback): () => void {
        exitListeners.add(callback)
        return () => exitListeners.delete(callback)
      }
    }
  }

  async stopContainer(id: string): Promise<void> {
    await execDocker(['stop', id])
  }

  async removeContainer(id: string): Promise<void> {
    await execDocker(['rm', id])
  }

  async listImages(options: { label?: string } = {}): Promise<DockerImageListEntry[]> {
    const args = ['image', 'ls', '--format', 'json']
    if (options.label) {
      args.splice(2, 0, '--filter', `label=${options.label}`)
    }
    const result = await execDocker(args)
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as {
          ID?: string
          Repository?: string
          Tag?: string
          Size?: string
        }
        return {
          id: parsed.ID ?? '',
          repository: parsed.Repository ?? '',
          tag: parsed.Tag ?? '',
          size: parsed.Size ?? ''
        }
      })
      .filter((entry) => entry.id.length > 0)
  }

  async inspectImage(id: string): Promise<DockerImageInspectInfo> {
    const result = await execDocker(['image', 'inspect', id, '--format', 'json'])
    const parsed = JSON.parse(result.stdout) as {
      Id?: string
      RepoTags?: string[]
      Config?: { Labels?: Record<string, string> | null }
      Size?: number
    }[]
    const image = parsed[0] ?? {}
    return {
      id: image.Id ?? id,
      repoTags: image.RepoTags ?? [],
      labels: image.Config?.Labels ?? {},
      sizeBytes: image.Size ?? 0
    }
  }

  async removeImage(id: string): Promise<void> {
    await execDocker(['image', 'rm', id])
  }
}

function buildExecArgs(options: DockerExecOptions): string[] {
  const args = ['exec']
  if (options.cwd) {
    args.push('--workdir', options.cwd)
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`)
  }
  args.push(options.containerId, ...options.args)
  return args
}

function labelArgs(labels: Record<string, string> | undefined): string[] {
  return Object.entries(labels ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`])
}

async function execDocker(
  args: string[],
  options: { input?: string; timeoutMs?: number; allowExitCodes?: number[] } = {}
): Promise<DockerExecResult> {
  if (options.input === undefined) {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      encoding: 'utf-8',
      timeout: options.timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: stdout as string, stderr: stderr as string, exitCode: 0 }
  }

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            settled = true
            child.kill('SIGKILL')
            reject(new Error(`docker ${args[0]} timed out after ${options.timeoutMs}ms`))
          }, options.timeoutMs)

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        reject(error)
      }
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      if (code && code !== 0 && !(options.allowExitCodes ?? []).includes(code)) {
        reject(new Error(stderr || `docker ${args[0]} exited with ${code}`))
        return
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
    child.stdin.end(options.input)
  })
}
