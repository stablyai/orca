/* eslint-disable max-lines */
import { spawn, execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

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
}

export type DockerCreateContainerOptions = {
  imageId: string
  workdir: string
  mounts: { source: string; target: string; readonly?: boolean }[]
  command?: string[]
  env?: Record<string, string>
  name?: string
}

export type DockerExecOptions = {
  containerId: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
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

export type DockerEngineClientLike = {
  buildImage(options: DockerBuildImageOptions): Promise<{ imageId: string }>
  pullImage(image: string): Promise<void>
  createContainer(options: DockerCreateContainerOptions): Promise<{ id: string }>
  startContainer(id: string): Promise<void>
  inspectContainer(id: string): Promise<{ id: string; imageId: string; running: boolean }>
  exec(options: DockerExecOptions): Promise<DockerExecResult>
  spawnExec(options: DockerExecSessionOptions): Promise<DockerExecSession>
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

  async inspectContainer(id: string): Promise<{ id: string; imageId: string; running: boolean }> {
    const result = await execDocker([
      'inspect',
      '--format',
      '{{.Id}} {{.Image}} {{.State.Running}}',
      id
    ])
    const [containerId, imageId, running] = result.stdout.trim().split(/\s+/)
    return { id: containerId, imageId, running: running === 'true' }
  }

  async exec(options: DockerExecOptions): Promise<DockerExecResult> {
    const args = buildExecArgs(options)
    return execDocker(args, { input: options.input, timeoutMs: options.timeoutMs })
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
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const dataListeners = new Set<(data: string) => void>()
    const replayListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(code: number) => void>()
    let buffer = ''
    let currentCwd = options.cwd
    let exitCode: number | null = null

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (const cb of dataListeners) {
        cb(chunk)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      for (const cb of dataListeners) {
        cb(chunk)
      }
    })
    child.on('close', (code) => {
      exitCode = code ?? 0
      for (const cb of exitListeners) {
        cb(exitCode)
      }
    })

    return {
      id,
      write(data): void {
        child.stdin.write(data)
      },
      resize(cols, rows): void {
        if (exitCode === null) {
          child.kill('SIGWINCH')
        }
        void cols
        void rows
      },
      async shutdown(immediate): Promise<void> {
        child.kill(immediate ? 'SIGKILL' : 'SIGTERM')
      },
      async sendSignal(signal): Promise<void> {
        if (exitCode === null) {
          child.kill(signal as NodeJS.Signals)
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

async function execDocker(
  args: string[],
  options: { input?: string; timeoutMs?: number } = {}
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
      if (code && code !== 0) {
        reject(new Error(stderr || `docker ${args[0]} exited with ${code}`))
        return
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
    child.stdin.end(options.input)
  })
}
