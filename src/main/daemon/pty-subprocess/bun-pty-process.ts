import type * as pty from 'node-pty'

type BunTerminal = {
  closed: boolean
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}

type BunSubprocess = {
  pid: number
  terminal: BunTerminal
  exited: Promise<number>
  kill(signal?: string | number): void
}

type BunRuntime = {
  spawn(
    command: string[],
    options: {
      cwd: string
      env: Record<string, string>
      terminal: {
        cols: number
        rows: number
        name: string
        data(terminal: BunTerminal, data: Uint8Array<ArrayBuffer>): void
      }
    }
  ): BunSubprocess
}

type BunGlobal = typeof globalThis & { Bun?: BunRuntime }

type BunPtyProcess = pty.IPty & {
  destroy(): void
}

export function canUseBunPty(): boolean {
  return typeof (globalThis as BunGlobal).Bun?.spawn === 'function'
}

export function spawnBunPty(args: {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}): BunPtyProcess {
  const runtime = (globalThis as BunGlobal).Bun
  if (!runtime) {
    throw new Error('Bun runtime is unavailable')
  }

  let processHandle: BunSubprocess
  let decodePending = ''
  const dataListeners: ((data: string) => void)[] = []
  const exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = []
  const decoder = new TextDecoder()
  let exited = false
  let exitCode = 0

  const emitData = (data: string): void => {
    for (const listener of dataListeners) {
      listener(data)
    }
  }

  const emitExit = (code: number): void => {
    if (exited) {
      return
    }
    exited = true
    exitCode = code
    const pending = decoder.decode()
    if (pending) {
      decodePending += pending
    }
    if (decodePending) {
      emitData(decodePending)
      decodePending = ''
    }
    for (const listener of exitListeners) {
      listener({ exitCode: code })
    }
  }

  processHandle = runtime.spawn([args.file, ...args.args], {
    cwd: args.cwd,
    env: args.env,
    terminal: {
      cols: args.cols,
      rows: args.rows,
      name: args.env.TERM ?? 'xterm-256color',
      data: (_terminal, data) => {
        const decoded = decoder.decode(data, { stream: true })
        if (decoded) {
          emitData(decoded)
        }
      }
    }
  })
  void processHandle.exited.then(emitExit, () => emitExit(1))

  return {
    pid: processHandle.pid,
    process: args.file,
    onData(listener) {
      dataListeners.push(listener)
    },
    onExit(listener) {
      if (exited) {
        listener({ exitCode })
        return
      }
      exitListeners.push(listener)
    },
    write(data) {
      if (!processHandle.terminal.closed) {
        processHandle.terminal.write(data)
      }
    },
    resize(cols, rows) {
      processHandle.terminal.resize(cols, rows)
    },
    kill() {
      processHandle.kill('SIGTERM')
    },
    destroy() {
      if (!processHandle.terminal.closed) {
        try {
          processHandle.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP')
        } catch {
          // The subprocess may have exited between the close and destroy calls.
        }
        processHandle.terminal.close()
      }
    }
  } as unknown as BunPtyProcess
}
